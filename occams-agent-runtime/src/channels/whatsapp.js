import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { config } from '../config.js'
import { handleMessage } from '../router.js'
import { findUserByWhatsapp } from '../users.js'
import { transcribeAudio } from '../transcribe.js'

const CHUNK = 3500

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
  // DM: remoteJid is "<phone>@s.whatsapp.net".
  // Group: remoteJid is "<group>@g.us" and participant carries the sender JID.
  const jid = msg.key.participant || msg.key.remoteJid || ''
  const match = jid.match(/^(\d+)(?::\d+)?@/)
  return match ? match[1] : null
}

async function sendChunked(sock, jid, text) {
  if (!text) return
  for (let i = 0; i < text.length; i += CHUNK) {
    await sock.sendMessage(jid, { text: text.slice(i, i + CHUNK) })
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'warn' }),
  })
  currentSock = sock

  sock.ev.on('creds.update', saveCreds)

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

      const phone = senderPhone(m)
      const user = await findUserByWhatsapp(phone)
      if (!user) {
        console.log(`[whatsapp] dropped message from ${phone || 'unknown'}: not in users.json`)
        continue
      }

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
      if (!text) continue

      const chatId = `whatsapp:${jid}`
      try {
        await sock.sendPresenceUpdate('composing', jid)
        // WhatsApp's "composing" indicator expires after ~10s. Refresh it whenever
        // the agent reports activity (tool use / thinking) so the user keeps seeing
        // the typing dots for the duration of long runs.
        const onEvent = (evt) => {
          if (evt.type === 'tool_use' || evt.type === 'thinking') {
            sock.sendPresenceUpdate('composing', jid).catch(() => {})
          }
        }
        const reply = await handleMessage({ text, chatId, channel: 'whatsapp', user, onEvent })
        await sendChunked(sock, jid, reply)
      } catch (err) {
        // The /stop command already sent its own "Stopped." reply on whatsapp;
        // suppress the would-be exit-code warning for the killed turn.
        if (err.name === 'StoppedError') {
          // no-op
        } else {
          console.error('[whatsapp] handler error:', err)
          await sock.sendMessage(jid, { text: `⚠️ ${err.message}` }).catch(() => {})
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
  await sendChunked(currentSock, jid, text)
}

export async function startWhatsapp() {
  await connect()
  return { sendDM }
}
