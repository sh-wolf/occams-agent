// Shared rendering for the live agent trace (tool calls, thinking, interim
// assistant text) used by both the Slack and WhatsApp channels. Keeping this
// in one place stops the two channels from drifting apart.

// Channels cap message text; trim the trace aggressively to leave room for
// the final answer above it.
export const MAX_TRANSCRIPT_CHARS = 3500

export function truncate(s, n) {
  if (!s) return ''
  const oneLine = String(s).replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

// Render a normalized agent event (from agent.js) as a single transcript line.
// Returns null for event types we don't display.
export function renderEvent(evt) {
  if (evt.type === 'agent_text' && evt.text) {
    return `💬 ${truncate(evt.text, 280)}`
  }
  if (evt.type === 'thinking' && evt.text) {
    return `💭 _${truncate(evt.text, 120)}_`
  }
  if (evt.type === 'tool_use') {
    const summary = evt.summary ? ` ${truncate(evt.summary, 100)}` : ''
    return `🔧 \`${evt.name}\`${summary}`
  }
  return null
}

export function buildTranscript(lines) {
  if (lines.length === 0) return ''
  let out = lines.join('\n')
  if (out.length > MAX_TRANSCRIPT_CHARS) {
    out = '…\n' + out.slice(out.length - MAX_TRANSCRIPT_CHARS)
  }
  return out
}

export function buildWorkingText(transcript) {
  const head = '🤔 _working…_'
  return transcript ? `${head}\n${transcript}` : head
}

export function buildFinalText(transcript, reply) {
  const body = reply || '(no output)'
  if (!transcript) return body
  // Answer up top, trace below in a quoted block so it stays scannable.
  return `${body}\n\n>\n> ${transcript.split('\n').join('\n> ')}`
}
