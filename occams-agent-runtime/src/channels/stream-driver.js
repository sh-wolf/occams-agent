// Shared streaming render model for Slack and WhatsApp so the two channels
// behave identically. A single editable "status" message per turn, plus the
// final answer:
//
//   streaming ON:
//     - interim assistant text -> each its own standalone message.
//     - tool calls + thinking  -> an accumulating "trace box", edited in place.
//     - final answer           -> its own standalone message.
//
//   streaming OFF ("working…"):
//     - one live ticker message shows the LATEST thought/tool/interim line,
//       edited in place as the run proceeds (nothing is posted separately).
//     - when the run ends the ticker is collapsed in place into just the
//       final answer (or error / stopped / attachment marker).
//
// The channel supplies the transport primitives:
//   post(text)            -> Promise<void>   standalone message (may chunk)
//   sendEditable(text)    -> Promise<handle> message we can later edit
//   edit(handle, text)    -> Promise<void>   edit a prior editable message
//   onActivity()          -> void            optional typing/presence ping
import { renderEvent, buildTranscript, buildWorkingText } from './stream-format.js'

export function createStreamDriver({
  streaming,
  renderIntervalMs,
  post,
  sendEditable,
  edit,
  onActivity,
  logTag = 'stream',
}) {
  // The single editable status message. On-mode it's the trace box; off-mode
  // it's the live "working…" ticker.
  let statusHandle = null
  let statusBroken = false
  const traceLines = []   // on-mode: full accumulating transcript
  let latestLine = ''     // off-mode: most recent line only
  let pendingTimer = null
  let inFlight = false
  let lastRenderAt = 0
  let needsRender = false
  // Serialize standalone interim sends so they arrive in order even though
  // onEvent may fire back-to-back. (On-mode only.)
  let interimQueue = Promise.resolve()

  function statusBody() {
    return streaming
      ? buildWorkingText(buildTranscript(traceLines))
      : buildWorkingText(latestLine)
  }

  async function render() {
    inFlight = true
    const body = statusBody()
    try {
      if (statusHandle == null || statusBroken) {
        statusHandle = await sendEditable(body)
        statusBroken = false
      } else {
        await edit(statusHandle, body)
      }
      lastRenderAt = Date.now()
    } catch (err) {
      console.error(`[${logTag}] status render failed:`, err.message)
      statusBroken = true
      statusHandle = await sendEditable(body).catch(() => null)
    } finally {
      inFlight = false
    }
  }

  function schedule() {
    needsRender = true
    if (pendingTimer || inFlight) return
    const wait = Math.max(0, renderIntervalMs - (Date.now() - lastRenderAt))
    pendingTimer = setTimeout(async () => {
      pendingTimer = null
      if (!needsRender) return
      needsRender = false
      await render()
      if (needsRender) schedule()
    }, wait)
  }

  // Off-mode: show the "working…" placeholder immediately for instant feedback.
  if (!streaming) schedule()

  function onEvent(evt) {
    if (onActivity) onActivity()
    const line = renderEvent(evt)
    if (streaming) {
      // Interim assistant text is its own standalone message; trace events
      // accumulate in the box.
      if (evt.type === 'agent_text' && evt.text) {
        const msg = evt.text.trim()
        interimQueue = interimQueue
          .then(() => post(msg))
          .catch((e) => console.error(`[${logTag}] interim send failed:`, e.message))
        return
      }
      if (!line) return
      traceLines.push(line)
      schedule()
      return
    }
    // Off-mode: everything (thinking, tools, interim text) folds into the one
    // live ticker as the latest line — nothing is posted as its own message.
    if (!line) return
    latestLine = line
    schedule()
  }

  // Called once the agent turn has ended. Flushes the status message, drains
  // queued interim messages, then delivers the final answer / stopped / error.
  async function finalize({ stopped = false, errorMessage = null, reply = '' } = {}) {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    if (inFlight) await new Promise((r) => setTimeout(r, 100))
    await interimQueue.catch(() => {})

    const finalText = errorMessage
      ? `⚠️ ${errorMessage}`
      : stopped
        ? '_(stopped)_'
        : reply

    // Streaming OFF: collapse the live ticker in place into the final surface.
    if (!streaming) {
      // The first render may still be queued; make sure the message exists.
      if (statusHandle == null && !statusBroken) await render().catch(() => {})
      if (statusHandle != null) {
        // reply === null means the channel handles the final surface itself
        // (e.g. an attachment-only reply). Resolve the ticker to a thin marker;
        // the media follows right after finalize.
        if (finalText === null) { await edit(statusHandle, '📎').catch(() => {}); return }
        try {
          await edit(statusHandle, finalText || '(no output)')
        } catch (err) {
          console.error(`[${logTag}] ticker collapse failed, posting fresh:`, err.message)
          await edit(statusHandle, '·').catch(() => {})
          await post(finalText || '(no output)').catch(() => {})
        }
        return
      }
      // Ticker never sent — fall through to a normal fresh post.
    } else if (traceLines.length) {
      needsRender = false
      await render()
    }

    if (errorMessage) { await post(`⚠️ ${errorMessage}`).catch(() => {}); return }
    if (stopped) { await post('_(stopped)_').catch(() => {}); return }
    // reply === null means the channel is handling the final surface itself
    // (e.g. WhatsApp parsed [[attach:...]] markers and the reply was nothing
    // but markers). Skip the (no output) placeholder in that case.
    if (reply === null) return
    await post(reply || '(no output)').catch((e) =>
      console.error(`[${logTag}] final send failed:`, e.message))
  }

  return { onEvent, finalize }
}
