import bolt from '@slack/bolt'
import { config } from '../config.js'
import { handleMessage } from '../router.js'
import { findUserBySlack } from '../users.js'
import { transcribeAudio } from '../transcribe.js'
import { getChatStreaming } from '../state.js'

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
// Slack message text caps at 40k chars. Trim aggressively to leave room.
const MAX_TRANSCRIPT_CHARS = 3500

function truncate(s, n) {
  if (!s) return ''
  const oneLine = String(s).replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

// Render a normalized agent event (from agent.js) as a single transcript line.
// Returns null for event types we don't display.
function renderEvent(evt) {
  if (evt.type === 'thinking' && evt.text) {
    return `💭 _${truncate(evt.text, 120)}_`
  }
  if (evt.type === 'tool_use') {
    const summary = evt.summary ? ` ${truncate(evt.summary, 100)}` : ''
    return `🔧 \`${evt.name}\`${summary}`
  }
  return null
}

function buildTranscript(lines) {
  if (lines.length === 0) return ''
  let out = lines.join('\n')
  if (out.length > MAX_TRANSCRIPT_CHARS) {
    out = '…\n' + out.slice(out.length - MAX_TRANSCRIPT_CHARS)
  }
  return out
}

function buildWorkingText(transcript) {
  const head = '🤔 _working…_'
  return transcript ? `${head}\n${transcript}` : head
}

function buildFinalText(transcript, reply) {
  const body = reply || '(no output)'
  if (!transcript) return body
  // Put the answer up top, trace below in a quoted block so it stays scannable.
  return `${body}\n\n>\n> ${transcript.split('\n').join('\n> ')}`
}

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

    if (!text) return

    const chatId = `slack:${event.channel}:${threadTs}`
    const streaming = await getChatStreaming(chatId)

    // Streaming off: skip placeholder + live edits, just post the final reply
    // as a thread message when the agent finishes.
    if (!streaming) {
      let reply
      let errorMessage = null
      try {
        reply = await handleMessage({ text, chatId, channel: 'slack', user })
      } catch (err) {
        // The /stop command already sent its own "Stopped." reply, so just
        // drop the original turn silently rather than posting an exit warning.
        if (err.name === 'StoppedError') return
        console.error('[slack] handler error:', err)
        errorMessage = err.message
      }
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: errorMessage ? `⚠️ ${errorMessage}` : (reply || '(no output)'),
      }).catch((err) => console.error('[slack] reply post failed:', err.message))
      return
    }

    let placeholder
    try {
      placeholder = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: '🤔 _working…_',
      })
    } catch (err) {
      console.error('[slack] could not post placeholder:', err.message)
      return
    }

    const transcriptLines = []
    let pendingTimer = null
    let inFlight = false
    let lastRenderAt = 0
    let needsRender = false

    async function doRender(textToSend) {
      inFlight = true
      try {
        await client.chat.update({
          channel: event.channel,
          ts: placeholder.ts,
          text: textToSend,
        })
        lastRenderAt = Date.now()
      } catch (err) {
        console.error('[slack] chat.update failed:', err.data?.error ?? err.message)
      } finally {
        inFlight = false
      }
    }

    function scheduleLiveRender() {
      needsRender = true
      if (pendingTimer || inFlight) return
      const wait = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - lastRenderAt))
      pendingTimer = setTimeout(async () => {
        pendingTimer = null
        if (!needsRender) return
        needsRender = false
        await doRender(buildWorkingText(buildTranscript(transcriptLines)))
        if (needsRender) scheduleLiveRender()
      }, wait)
    }

    function onEvent(evt) {
      const line = renderEvent(evt)
      if (!line) return
      transcriptLines.push(line)
      scheduleLiveRender()
    }

    let reply
    let errorMessage = null
    let stopped = false
    try {
      reply = await handleMessage({ text, chatId, channel: 'slack', user, onEvent })
    } catch (err) {
      if (err.name === 'StoppedError') {
        stopped = true
      } else {
        console.error('[slack] handler error:', err)
        errorMessage = err.message
      }
    }

    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    // Wait briefly for any in-flight update to settle before the final edit.
    if (inFlight) await new Promise((r) => setTimeout(r, 100))

    const transcript = buildTranscript(transcriptLines)
    let finalText
    if (stopped) {
      finalText = transcript ? `_(stopped)_\n\n>\n> ${transcript.split('\n').join('\n> ')}` : '_(stopped)_'
    } else if (errorMessage) {
      finalText = `⚠️ ${errorMessage}${transcript ? `\n\n>\n> ${transcript.split('\n').join('\n> ')}` : ''}`
    } else {
      finalText = buildFinalText(transcript, reply)
    }

    await doRender(finalText)
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
    await app.client.chat.postMessage({ channel: userId, text })
  }
  return { app, sendDM }
}
