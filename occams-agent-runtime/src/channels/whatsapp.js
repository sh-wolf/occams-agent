import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'fs/promises'
import path from 'path'
import { config } from '../config.js'
import { handleMessage } from '../router.js'
import { findUserByWhatsapp } from '../users.js'
import { transcribeAudio } from '../transcribe.js'
import { getChatStreaming } from '../state.js'
import { createStreamDriver } from './stream-driver.js'
import { toWhatsappText } from './whatsapp-format.js'

const CHUNK = 3500
// WhatsApp is tighter on edit rate than Slack's chat.update (~1/s). Edit the
// live trace message at most this often.
const RENDER_INTERVAL_MS = 1800

let currentSock = null

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  )
}

function senderPhone(msg) {
  // WhatsApp's LID privacy mode makes remoteJid/participant a "<lid>@lid"
  // identifier instead of the phone number, so the naive "digits before @"
  // yields the LID, not a number that can match users.json. Baileys surfaces
  // the real number on senderPn (DMs) / participantPn (groups) — prefer those.
  //   DM (no LID):  remoteJid = "<phone>@s.whatsapp.net"
  //   DM (LID):     remoteJid = "<lid>@lid", senderPn = "<phone>@s.whatsapp.net"
  //   Group:        participant / participantPn carry the sender.
  const jid =
    msg.key.senderPn ||
    msg.key.participantPn ||
    msg.key.participant ||
    msg.key.remoteJid ||
    ''
  const match = jid.match(/^(\d+)(?::\d+)?@/)
  return match ? match[1] : null
}

async function sendChunked(sock, jid, text) {
  if (!text) return
  for (let i = 0; i < text.length; i += CHUNK) {
    await sock.sendMessage(jid, { text: text.slice(i, i + CHUNK) })
  }
}

// Agents can request outbound media by embedding `[[attach:/abs/path]]` in
// their reply. We pull markers out of the text, send the cleaned text first,
// then dispatch each file as a follow-up media message.
const ATTACH_RE = /\[\[attach:([^\]]+)\]\]/g

function extractAttachments(text) {
  if (!text) return { cleaned: '', paths: [] }
  const paths = []
  let m
  ATTACH_RE.lastIndex = 0
  while ((m = ATTACH_RE.exec(text)) !== null) paths.push(m[1].trim())
  const cleaned = text.replace(ATTACH_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  return { cleaned, paths }
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const AUDIO_EXTS = new Set(['.ogg', '.mp3', '.m4a', '.wav', '.opus'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv'])

function mimeFor(ext) {
  switch (ext) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.mp3': return 'audio/mpeg'
    case '.m4a': return 'audio/mp4'
    case '.wav': return 'audio/wav'
    case '.opus':
    case '.ogg': return 'audio/ogg'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.mkv': return 'video/x-matroska'
    default: return 'application/octet-stream'
  }
}

async function sendAttachment(sock, jid, filePath) {
  const abs = path.resolve(filePath)
  const buf = await fs.readFile(abs)
  const ext = path.extname(abs).toLowerCase()
  const name = path.basename(abs)
  const mimetype = mimeFor(ext)
  console.log(`[whatsapp] sending attachment ${name} (${mimetype}, ${buf.length} bytes)`)
  if (IMAGE_EXTS.has(ext)) {
    await sock.sendMessage(jid, { image: buf, mimetype })
  } else if (AUDIO_EXTS.has(ext)) {
    await sock.sendMessage(jid, { audio: buf, mimetype })
  } else if (VIDEO_EXTS.has(ext)) {
    await sock.sendMessage(jid, { video: buf, mimetype })
  } else {
    await sock.sendMessage(jid, { document: buf, fileName: name, mimetype })
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  const { version } = await fetchLatestBaileysVersion()

  // Wrapping state.keys in a cacheable signal key store is the fix for the
  // endless "Closing session" churn and undecryptable "Waiting for this
  // message" replies (most visible in groups). Without it, concurrent
  // encrypt/decrypt ops keep re-reading stale Signal key state off disk and
  // tearing sessions down. syncFullHistory/markOnlineOnConnect off keeps the
  // bot quiet and avoids needless history sync work. (Mirrors OpenClaw.)
  const logger = pino({ level: 'warn' })
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })
  currentSock = sock

  // Serialize creds writes. The raw saveCreds from useMultiFileAuthState is
  // not reentrant; concurrent creds.update events race the auth files and
  // corrupt Signal state — the other half of the decryption-churn problem.
  let credsChain = Promise.resolve()
  sock.ev.on('creds.update', () => {
    credsChain = credsChain
      .then(() => saveCreds())
      .catch((err) => console.error('[whatsapp] saveCreds failed:', err.message))
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log('[whatsapp] scan this QR with your phone:')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log('[whatsapp] connected')
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`[whatsapp] disconnected (code ${code}); reconnect=${shouldReconnect}`)
      currentSock = null
      if (shouldReconnect) connect().catch(console.error)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      if (m.key.fromMe) continue
      if (!m.message) continue

      // Cheap pre-filter, before the users.json lookup: WhatsApp pushes every
      // Status/Story and Channel post to a linked device. None of it is ever
      // actionable, so short-circuit it silently (no log) to keep the path
      // cheap and the logs clean.
      const remoteJid = m.key.remoteJid ?? ''
      if (
        remoteJid === 'status@broadcast' ||
        remoteJid.endsWith('@broadcast') ||
        remoteJid.endsWith('@newsletter')
      ) {
        continue
      }

      // Allowlist gate: drop anything not from a number in users.json. Fully
      // silent by design — unknown senders get nothing and leave no trace.
      // (Fail-closed: no resolvable number / empty allowlist => dropped.)
      const phone = senderPhone(m)
      const user = await findUserByWhatsapp(phone)
      if (!user) continue

      const jid = m.key.remoteJid

      // If this is a voice note (audioMessage), download + transcribe and
      // fold the transcript into the message text. Captions (when the user
      // includes text along with the audio — rare on WhatsApp) are preserved.
      let text = extractText(m)
      if (m.message?.audioMessage) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {}, {
            reuploadRequest: sock.updateMediaMessage,
          })
          const mimeType = m.message.audioMessage.mimetype || 'audio/ogg'
          console.log(`[whatsapp] transcribing voice note (${mimeType}, ${buf.length} bytes)`)
          const t = await transcribeAudio({
            buffer: buf,
            filename: `voice-${m.key.id}.ogg`,
            mimeType,
          })
          const tagged = `[voice]: ${t}`
          text = text ? `${text}\n\n${tagged}` : tagged
        } catch (err) {
          console.error('[whatsapp] transcription failed:', err.message)
          await sock.sendMessage(jid, {
            text: `⚠️ Couldn't transcribe voice note: ${err.message}`,
          }).catch(() => {})
          continue
        }
      }
      // Image messages: download and pass through as attachments. The agent
      // layer writes them into the profile scratch and points the Read tool
      // at them (it renders images natively).
      const attachments = []
      if (m.message?.imageMessage) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {}, {
            reuploadRequest: sock.updateMediaMessage,
          })
          const mimeType = m.message.imageMessage.mimetype || 'image/jpeg'
          console.log(`[whatsapp] received image (${mimeType}, ${buf.length} bytes)`)
          attachments.push({ buffer: buf, mimetype: mimeType, name: `image-${m.key.id}` })
        } catch (err) {
          console.error('[whatsapp] image download failed:', err.message)
          await sock.sendMessage(jid, {
            text: `⚠️ Couldn't fetch image: ${err.message}`,
          }).catch(() => {})
          continue
        }
      }
      if (!text && attachments.length > 0) text = '(image)'
      if (!text) continue

      const chatId = `whatsapp:${jid}`
      const streaming = await getChatStreaming(chatId)
      try {
        await sock.sendPresenceUpdate('composing', jid)

        const driver = createStreamDriver({
          streaming,
          renderIntervalMs: RENDER_INTERVAL_MS,
          post: (t) => sendChunked(sock, jid, toWhatsappText(t)),
          sendEditable: (t) => sock.sendMessage(jid, { text: toWhatsappText(t) }),
          edit: (handle, t) => sock.sendMessage(jid, { text: toWhatsappText(t), edit: handle.key }),
          onActivity: () => sock.sendPresenceUpdate('composing', jid).catch(() => {}),
          logTag: 'whatsapp',
        })

        let reply = ''
        let stopped = false
        let errorMessage = null
        try {
          reply = await handleMessage({ text, chatId, channel: 'whatsapp', user, attachments, onEvent: driver.onEvent })
        } catch (err) {
          if (err.name === 'StoppedError') stopped = true
          else { console.error('[whatsapp] handler error:', err); errorMessage = err.message }
        }
        const { cleaned, paths: outPaths } = extractAttachments(reply)
        // If the agent's reply was nothing but markers, skip the placeholder
        // text so the user just gets the attachments.
        const finalReply = cleaned || (outPaths.length > 0 ? null : reply)
        await driver.finalize({ stopped, errorMessage, reply: finalReply })
        for (const p of outPaths) {
          try {
            await sendAttachment(sock, jid, p)
          } catch (err) {
            console.error('[whatsapp] attachment failed:', err.message)
            await sock.sendMessage(jid, {
              text: `⚠️ Couldn't attach ${p}: ${err.message}`,
            }).catch(() => {})
          }
        }
      } finally {
        await sock.sendPresenceUpdate('paused', jid).catch(() => {})
      }
    }
  })
}

async function sendDM(phone, text) {
  if (!currentSock) throw new Error('whatsapp not connected')
  const jid = `${phone}@s.whatsapp.net`
  const { cleaned, paths: outPaths } = extractAttachments(text)
  if (cleaned) await sendChunked(currentSock, jid, toWhatsappText(cleaned))
  for (const p of outPaths) {
    try {
      await sendAttachment(currentSock, jid, p)
    } catch (err) {
      console.error('[whatsapp] sendDM attachment failed:', err.message)
      await currentSock.sendMessage(jid, {
        text: `⚠️ Couldn't attach ${p}: ${err.message}`,
      }).catch(() => {})
    }
  }
}

export async function startWhatsapp() {
  await connect()
  return { sendDM }
}
