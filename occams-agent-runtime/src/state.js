import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'

let cache = null
let writing = Promise.resolve()

async function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(config.stateFile, 'utf8'))
  } catch {
    cache = {}
  }
  cache.chats ??= {}
  return cache
}

async function save() {
  writing = writing.then(() => writeFile(config.stateFile, JSON.stringify(cache, null, 2)))
  return writing
}

function chatEntry(state, chatId) {
  state.chats[chatId] ??= { profile: null, sessions: {} }
  state.chats[chatId].sessions ??= {}
  return state.chats[chatId]
}

export async function getProfileBinding(chatId) {
  const state = await load()
  return state.chats[chatId]?.profile ?? null
}

export async function setProfileBinding(chatId, profileSlug) {
  const state = await load()
  const entry = chatEntry(state, chatId)
  entry.profile = profileSlug
  await save()
}

export async function getSession(chatId, profileSlug, agentCli) {
  const state = await load()
  return state.chats[chatId]?.sessions?.[profileSlug]?.[agentCli] ?? null
}

export async function setSession(chatId, profileSlug, agentCli, sessionId) {
  const state = await load()
  const entry = chatEntry(state, chatId)
  entry.sessions[profileSlug] ??= {}
  entry.sessions[profileSlug][agentCli] = sessionId
  await save()
}

export async function ensureClaudeSession(chatId, profileSlug) {
  let id = await getSession(chatId, profileSlug, 'claude')
  const isNew = !id
  if (isNew) {
    id = randomUUID()
    await setSession(chatId, profileSlug, 'claude', id)
  }
  return { id, isNew }
}

// Clear all CLI sessions for this chat (keeps the profile binding).
// Use for `/new` or `/reset` — "fresh conversation, same agent".
export async function clearChatSessions(chatId) {
  const state = await load()
  const entry = state.chats[chatId]
  if (!entry || !entry.sessions || Object.keys(entry.sessions).length === 0) {
    return false
  }
  entry.sessions = {}
  await save()
  return true
}

// Per-chat streaming mode. When off, channels suppress the live tool-call trace
// and only show the final answer. Defaults to on for new chats.
export async function getChatStreaming(chatId) {
  const state = await load()
  return state.chats[chatId]?.streaming !== false
}

export async function setChatStreaming(chatId, on) {
  const state = await load()
  const entry = chatEntry(state, chatId)
  entry.streaming = Boolean(on)
  await save()
}

// Wipe everything for this chat — both profile binding and sessions.
// Use only if the user explicitly wants to start over from scratch.
export async function clearChat(chatId) {
  const state = await load()
  const had = Boolean(state.chats[chatId])
  delete state.chats[chatId]
  await save()
  return had
}
