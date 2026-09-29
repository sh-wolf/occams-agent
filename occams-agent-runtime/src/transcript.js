import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { listChatState } from './state.js'

// The runtime's event store (registry.store.events) only captures runs it
// executed through its own pipeline, so it loses history for chats whose
// conversation happened before event recording (e.g. synced Slack/WhatsApp
// threads). The CLI agents, however, persist the *complete* transcript in
// their own session files. This module reads those session files and
// normalizes them into the same AgentEvent shape `listEvents` returns, so the
// dashboard can show full history without depending on the event recorder.

const MAX_TEXT = 4000
const MAX_EVENTS = 800

function home() {
  return process.env.HOME || process.env.USERPROFILE || ''
}

function truncate(value, limit = MAX_TEXT) {
  if (value == null) return ''
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  return str.length > limit ? `${str.slice(0, limit)}…` : str
}

// Claude Code encodes the session's cwd into the project directory name by
// replacing every non-alphanumeric character with '-'. We try that fast path
// first, then fall back to scanning project dirs for the session UUID (which
// is globally unique), so we stay correct even if the encoding scheme shifts.
async function findClaudeSessionFile(sessionId) {
  const root = path.join(home(), '.claude', 'projects')
  const profileCwd = path.join(config.vaultDir, 'users')
  const encoded = `${profileCwd}`.replace(/[^a-zA-Z0-9]/g, '-')

  let dirs
  try {
    dirs = await readdir(root)
  } catch {
    return null
  }

  const ordered = dirs.sort((a, b) => {
    const aHit = a.startsWith(encoded) ? 0 : 1
    const bHit = b.startsWith(encoded) ? 0 : 1
    return aHit - bHit
  })

  for (const dir of ordered) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`)
    try {
      await stat(candidate)
      return candidate
    } catch {
      // not in this project dir; keep scanning
    }
  }
  return null
}

async function findCodexSessionFile(sessionId) {
  const root = path.join(home(), '.codex', 'sessions')
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
        return full
      }
    }
  }
  return null
}

function parseLines(raw) {
  const out = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // Partially written trailing line during an active run; skip it.
    }
  }
  return out
}

function blockToEvents(role, content, base) {
  const events = []
  if (typeof content === 'string') {
    if (content.trim()) {
      events.push({ ...base, type: role === 'user' ? 'user_message' : 'assistant_message', text: truncate(content) })
    }
    return events
  }
  if (!Array.isArray(content)) return events

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && block.text) {
      events.push({ ...base, type: role === 'user' ? 'user_message' : 'assistant_message', text: truncate(block.text) })
    } else if (block.type === 'tool_use') {
      events.push({ ...base, type: 'tool_use', name: block.name ?? 'tool', summary: truncate(block.input, 600) })
    } else if (block.type === 'tool_result') {
      const resultText = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((c) => (c && c.text) || '').join('\n')
          : block.content
      events.push({ ...base, type: 'tool_result', name: 'result', text: truncate(resultText, 1200) })
    }
  }
  return events
}

function normalizeClaude(records, chatId) {
  const events = []
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.isSidechain === true || rec.isMeta === true) continue
    if (rec.type !== 'user' && rec.type !== 'assistant') continue
    const msg = rec.message
    if (!msg) continue
    const base = {
      id: rec.uuid ?? undefined,
      chatId,
      createdAt: rec.timestamp ?? undefined,
    }
    for (const ev of blockToEvents(msg.role ?? rec.type, msg.content, base)) {
      events.push(ev)
    }
  }
  return events
}

function normalizeCodex(records, chatId) {
  const events = []
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const payload = rec.payload ?? rec
    const createdAt = rec.timestamp ?? payload.timestamp ?? undefined
    const base = { chatId, createdAt }

    if (payload.type === 'message' && payload.role) {
      const content = Array.isArray(payload.content)
        ? payload.content.map((c) => c && (c.text ?? c.content ?? '')).filter(Boolean).join('\n')
        : payload.content
      if (content && String(content).trim()) {
        events.push({
          ...base,
          type: payload.role === 'user' ? 'user_message' : 'assistant_message',
          text: truncate(content),
        })
      }
    } else if (payload.type === 'function_call' || payload.type === 'local_shell_call') {
      events.push({
        ...base,
        type: 'tool_use',
        name: payload.name ?? payload.type,
        summary: truncate(payload.arguments ?? payload.action, 600),
      })
    } else if (payload.type === 'function_call_output') {
      events.push({ ...base, type: 'tool_result', name: 'result', text: truncate(payload.output, 1200) })
    }
  }
  return events
}

async function readAgentTranscript(agentCli, sessionId, chatId) {
  const file = agentCli === 'codex'
    ? await findCodexSessionFile(sessionId)
    : await findClaudeSessionFile(sessionId)
  if (!file) return []

  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const records = parseLines(raw)
  return agentCli === 'codex'
    ? normalizeCodex(records, chatId)
    : normalizeClaude(records, chatId)
}

// Returns the full transcript for a chat as AgentEvent[], or null if no CLI
// session exists for it (caller should then fall back to the event store).
export async function readChatTranscript(chatId) {
  const states = await listChatState()
  const entry = states.find((s) => s.chatId === chatId)
  if (!entry || !entry.sessions) return null

  const preferredProfile = entry.profile
  const profileSlugs = Object.keys(entry.sessions)
  if (profileSlugs.length === 0) return null
  const orderedProfiles = preferredProfile && entry.sessions[preferredProfile]
    ? [preferredProfile, ...profileSlugs.filter((p) => p !== preferredProfile)]
    : profileSlugs

  for (const profileSlug of orderedProfiles) {
    const agents = entry.sessions[profileSlug] ?? {}
    const orderedAgents = config.defaultAgent && agents[config.defaultAgent]
      ? [config.defaultAgent, ...Object.keys(agents).filter((a) => a !== config.defaultAgent)]
      : Object.keys(agents)

    for (const agentCli of orderedAgents) {
      const sessionId = agents[agentCli]
      if (!sessionId) continue
      const events = await readAgentTranscript(agentCli, sessionId, chatId)
      if (events.length > 0) {
        return events.slice(-MAX_EVENTS)
      }
    }
  }
  return null
}
