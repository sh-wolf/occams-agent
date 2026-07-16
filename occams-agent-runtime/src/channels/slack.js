import bolt from '@slack/bolt'
import { config } from '../config.js'
import { handleMessage } from '../router.js'
import { findUserBySlack } from '../users.js'
import { transcribeAudio } from '../transcribe.js'
import { getChatStreaming } from '../state.js'
import { createStreamDriver } from './stream-driver.js'
import { toSlackMrkdwn } from './slack-format.js'

const { App } = bolt

// Slack message subtypes to ignore. We intentionally do NOT skip `file_share`
// so voice notes and image uploads come through.
const SKIP_SUBTYPES = new Set([
  'bot_message',
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
])

async function downloadSlackFile(fileObj, botToken) {
  const url = fileObj.url_private_download ?? fileObj.url_private
  if (!url) throw new Error(`slack file has no download URL: ${fileObj.id}`)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } })
  if (!res.ok) throw new Error(`slack file download failed (HTTP ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

// Slack chat.update is limited to ~1/sec per channel. Throttle live edits.
const RENDER_INTERVAL_MS = 700

export async function startSlack() {
  if (!config.slack.botToken || !config.slack.appToken) {
    throw new Error('Slack enabled but SLACK_BOT_TOKEN / SLACK_APP_TOKEN are missing.')
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  })

  const seen = new Set()
  const remember = (id) => {
    seen.add(id)
    if (seen.size > 1000) seen.delete(seen.values().next().value)
  }

  async function respond({ event, client }) {
    if (event.bot_id) return
    if (event.subtype && SKIP_SUBTYPES.has(event.subtype)) return
    if (seen.has(event.ts)) return
    remember(event.ts)

    const user = await findUserBySlack(event.user)
    if (!user) {
      console.log(`[slack] dropped message from ${event.user || 'unknown'}: not in users.json`)
      return
    }

    const threadTs = event.thread_ts ?? event.ts
    let text = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim()

    // Voice notes / audio uploads: download, transcribe via Groq, fold the
    // transcript into the message text. Tag with "[voice]:" so the agent
    // knows the input was spoken.
    const audioFiles = (event.files ?? []).filter((f) => (f.mimetype ?? '').startsWith('audio/'))
    if (audioFiles.length > 0) {
      const transcripts = []
      for (const f of audioFiles) {
        try {
          const buf = await downloadSlackFile(f, config.slack.botToken)
          console.log(`[slack] transcribing ${f.name} (${f.mimetype}, ${buf.length} bytes)`)
          const t = await transcribeAudio({ buffer: buf, filename: f.name, mimeType: f.mimetype })
          transcripts.push(t)
        } catch (err) {
          console.error(`[slack] transcription failed for ${f.name}:`, err.message)
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: `⚠️ Couldn't transcribe voice note: ${err.message}`,
          }).catch(() => {})
          return
        }
      }
      const joined = transcripts.map((t) => `[voice]: ${t}`).join('\n\n')
      text = text ? `${text}\n\n${joined}` : joined
    }

    // Image uploads: download and pass through as attachments. The agent
    // layer writes them into the profile scratch and points the Read tool
    // at them (it renders images natively).
    const attachments = []
    const imageFiles = (event.files ?? []).filter((f) => (f.mimetype ?? '').startsWith('image/'))
    for (const f of imageFiles) {
      try {
        const buf = await downloadSlackFile(f, config.slack.botToken)
        console.log(`[slack] received image ${f.name} (${f.mimetype}, ${buf.length} bytes)`)
        attachments.push({ buffer: buf, mimetype: f.mimetype, name: f.name })
      } catch (err) {
        console.error(`[slack] image download failed for ${f.name}:`, err.message)
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: `⚠️ Couldn't fetch image ${f.name}: ${err.message}`,
        }).catch(() => {})
        return
      }
    }
    if (!text && attachments.length > 0) text = '(image)'

    if (!text) return

    const chatId = `slack:${event.channel}:${threadTs}`
    const streaming = await getChatStreaming(chatId)

    const driver = createStreamDriver({
      streaming,
      renderIntervalMs: RENDER_INTERVAL_MS,
      post: (t) =>
        client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: toSlackMrkdwn(t) }),
      sendEditable: (t) =>
        client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: toSlackMrkdwn(t) }),
      edit: (handle, t) =>
        client.chat.update({ channel: event.channel, ts: handle.ts, text: toSlackMrkdwn(t) }),
      logTag: 'slack',
    })

    let reply = ''
    let stopped = false
    let errorMessage = null
    try {
      reply = await handleMessage({ text, chatId, channel: 'slack', user, attachments, onEvent: driver.onEvent })
    } catch (err) {
      if (err.name === 'StoppedError') stopped = true
      else { console.error('[slack] handler error:', err); errorMessage = err.message }
    }
    await driver.finalize({ stopped, errorMessage, reply })
  }

  app.event('app_mention', respond)
  app.message(async ({ message, client }) => {
    if (message.channel_type !== 'im') return
    await respond({ event: message, client })
  })

  await app.start()
  console.log('[slack] connected (socket mode)')

  async function sendDM(userId, text) {
    // Slack accepts a user ID as channel in chat.postMessage; it opens the IM.
    await app.client.chat.postMessage({ channel: userId, text: toSlackMrkdwn(text) })
  }
  return { app, sendDM }
}
