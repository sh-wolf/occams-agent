import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'

const STORE_FILE = path.join(config.runtimeDataDir, 'control-plane.json')
const EVENT_LIMIT = 5000
const RUN_LIMIT = 1000
const TASK_STATUSES = new Set(['todo', 'in_progress', 'done'])
const CHAT_STATUSES = new Set(['idle', 'queued', 'running', 'completed', 'failed', 'stopped'])
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

let cache = null
let mutex = Promise.resolve()

function now() {
  return new Date().toISOString()
}

function makeId(prefix) {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = randomUUID().slice(0, 8)
  return `${prefix}-${ts}-${rand}`
}

function preview(text, length = 500) {
  if (text == null) return ''
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > length ? `${s.slice(0, length - 1)}…` : s
}

function ensureStoreShape(store) {
  store.version ??= 1
  store.projects ??= {}
  store.tasks ??= {}
  store.chats ??= {}
  store.aliases ??= {}
  store.runs ??= {}
  store.events ??= []
  store.jobRuns ??= {}
  return store
}

async function load() {
  if (cache) return cache
  try {
    cache = ensureStoreShape(JSON.parse(await readFile(STORE_FILE, 'utf8')))
  } catch {
    cache = ensureStoreShape({})
  }
  return cache
}

async function save(store) {
  await mkdir(config.runtimeDataDir, { recursive: true })
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n')
  await rename(tmp, STORE_FILE)
}

async function mutate(fn) {
  const op = mutex.then(async () => {
    const store = await load()
    const result = await fn(store)
    await save(store)
    return result
  })
  mutex = op.catch(() => {})
  return op
}

function touch(entity, ts = now()) {
  entity.updatedAt = ts
  return entity
}

function sortedValues(obj) {
  return Object.values(obj).sort((a, b) => {
    const at = a.updatedAt ?? a.createdAt ?? ''
    const bt = b.updatedAt ?? b.createdAt ?? ''
    return bt.localeCompare(at)
  })
}

function requireTitle(title) {
  const t = String(title ?? '').trim()
  if (!t) throw new Error('title is required')
  return t
}

function requireKey(key, label = 'id') {
  const value = String(key ?? '').trim()
  if (!value) throw new Error(`${label} is required`)
  if (value.length > 240 || value.includes('\0') || RESERVED_KEYS.has(value)) {
    throw new Error(`invalid ${label}: ${value}`)
  }
  return value
}

function normalizeTaskStatus(status) {
  const s = String(status ?? 'todo').toLowerCase()
  if (!TASK_STATUSES.has(s)) throw new Error(`invalid task status "${status}"`)
  return s
}

function normalizeChatStatus(status) {
  const s = String(status ?? 'idle').toLowerCase()
  if (!CHAT_STATUSES.has(s)) throw new Error(`invalid chat status "${status}"`)
  return s
}

function getTaskOrThrow(store, taskId) {
  taskId = requireKey(taskId, 'task id')
  const task = store.tasks[taskId]
  if (!task) throw new Error(`unknown task "${taskId}"`)
  return task
}

function getChatOrThrow(store, chatId) {
  chatId = requireKey(chatId, 'chat id')
  const chat = store.chats[chatId]
  if (!chat) throw new Error(`unknown chat "${chatId}"`)
  return chat
}

function ensureChatInStore(store, chatId, attrs = {}) {
  chatId = requireKey(chatId, 'chat id')
  const ts = now()
  if (!store.chats[chatId]) {
    store.chats[chatId] = {
      id: chatId,
      title: attrs.title || chatId,
      profile: attrs.profile ?? null,
      userSlug: attrs.userSlug ?? null,
      status: attrs.status ?? 'idle',
      taskIds: [],
      aliases: [],
      createdAt: ts,
      updatedAt: ts,
    }
  }
  const chat = store.chats[chatId]
  for (const key of ['title', 'profile', 'userSlug']) {
    if (attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '') chat[key] = attrs[key]
  }
  if (attrs.status) chat.status = normalizeChatStatus(attrs.status)
  return touch(chat, ts)
}

function linkChatToTaskInStore(store, taskId, chatId) {
  const task = getTaskOrThrow(store, taskId)
  const chat = ensureChatInStore(store, chatId)
  task.chatIds ??= []
  chat.taskIds ??= []
  if (!task.chatIds.includes(chatId)) task.chatIds.push(chatId)
  if (!chat.taskIds.includes(taskId)) chat.taskIds.push(taskId)
  const ts = now()
  touch(task, ts)
  touch(chat, ts)
  return { task, chat }
}

export async function listProjects() {
  const store = await load()
  return sortedValues(store.projects)
}

export async function createProject(input = {}) {
  return mutate((store) => {
    const id = requireKey(input.id || makeId('project'), 'project id')
    if (store.projects[id]) throw new Error(`project "${id}" already exists`)
    const ts = now()
    const project = {
      id,
      title: requireTitle(input.title),
      description: String(input.description ?? ''),
      createdAt: ts,
      updatedAt: ts,
    }
    store.projects[id] = project
    return project
  })
}

export async function updateProject(id, patch = {}) {
  id = requireKey(id, 'project id')
  return mutate((store) => {
    const project = store.projects[id]
    if (!project) throw new Error(`unknown project "${id}"`)
    if (patch.title !== undefined) project.title = requireTitle(patch.title)
    if (patch.description !== undefined) project.description = String(patch.description ?? '')
    return touch(project)
  })
}

export async function deleteProject(id) {
  id = requireKey(id, 'project id')
  return mutate((store) => {
    if (!store.projects[id]) throw new Error(`unknown project "${id}"`)
    delete store.projects[id]
    for (const task of Object.values(store.tasks)) {
      if (task.projectId === id) task.projectId = null
    }
    return { ok: true }
  })
}

export async function listTasks(filters = {}) {
  const store = await load()
  let tasks = sortedValues(store.tasks)
  if (filters.projectId) tasks = tasks.filter((t) => t.projectId === filters.projectId)
  if (filters.status) tasks = tasks.filter((t) => t.status === filters.status)
  return tasks
}

export async function getTask(taskId) {
  taskId = requireKey(taskId, 'task id')
  const store = await load()
  return store.tasks[taskId] ?? null
}

export async function createTask(input = {}) {
  return mutate((store) => {
    const id = requireKey(input.id || makeId('task'), 'task id')
    if (store.tasks[id]) throw new Error(`task "${id}" already exists`)
    const projectId = input.projectId ? requireKey(input.projectId, 'project id') : null
    if (projectId && !store.projects[projectId]) {
      throw new Error(`unknown project "${projectId}"`)
    }
    const ts = now()
    const task = {
      id,
      projectId,
      title: requireTitle(input.title),
      description: String(input.description ?? ''),
      status: normalizeTaskStatus(input.status ?? 'todo'),
      chatIds: [],
      vaultPaths: Array.isArray(input.vaultPaths) ? [...input.vaultPaths] : [],
      jobIds: Array.isArray(input.jobIds) ? [...input.jobIds] : [],
      createdAt: ts,
      updatedAt: ts,
    }
    store.tasks[id] = task
    return task
  })
}

export async function updateTask(taskId, patch = {}) {
  taskId = requireKey(taskId, 'task id')
  return mutate((store) => {
    const task = getTaskOrThrow(store, taskId)
    if (patch.projectId !== undefined) {
      const projectId = patch.projectId ? requireKey(patch.projectId, 'project id') : null
      if (projectId && !store.projects[projectId]) throw new Error(`unknown project "${projectId}"`)
      task.projectId = projectId
    }
    if (patch.title !== undefined) task.title = requireTitle(patch.title)
    if (patch.description !== undefined) task.description = String(patch.description ?? '')
    if (patch.status !== undefined) task.status = normalizeTaskStatus(patch.status)
    if (Array.isArray(patch.vaultPaths)) task.vaultPaths = [...patch.vaultPaths]
    if (Array.isArray(patch.jobIds)) task.jobIds = [...patch.jobIds]
    return touch(task)
  })
}

export async function deleteTask(taskId) {
  taskId = requireKey(taskId, 'task id')
  return mutate((store) => {
    const task = getTaskOrThrow(store, taskId)
    for (const chatId of task.chatIds ?? []) {
      const chat = store.chats[chatId]
      if (chat) chat.taskIds = (chat.taskIds ?? []).filter((id) => id !== taskId)
    }
    delete store.tasks[taskId]
    return { ok: true }
  })
}

export async function linkChatToTask(taskId, chatId) {
  taskId = requireKey(taskId, 'task id')
  chatId = requireKey(chatId, 'chat id')
  return mutate((store) => linkChatToTaskInStore(store, taskId, chatId))
}

export async function unlinkChatFromTask(taskId, chatId) {
  taskId = requireKey(taskId, 'task id')
  chatId = requireKey(chatId, 'chat id')
  return mutate((store) => {
    const task = getTaskOrThrow(store, taskId)
    const chat = getChatOrThrow(store, chatId)
    task.chatIds = (task.chatIds ?? []).filter((id) => id !== chatId)
    chat.taskIds = (chat.taskIds ?? []).filter((id) => id !== taskId)
    const ts = now()
    touch(task, ts)
    touch(chat, ts)
    return { task, chat }
  })
}

export async function listChats(filters = {}) {
  const store = await load()
  let chats = sortedValues(store.chats)
  if (filters.status) chats = chats.filter((c) => c.status === filters.status)
  if (filters.profile) chats = chats.filter((c) => c.profile === filters.profile)
  if (filters.taskId) chats = chats.filter((c) => (c.taskIds ?? []).includes(filters.taskId))
  return chats
}

export async function getChat(chatId) {
  chatId = requireKey(chatId, 'chat id')
  const store = await load()
  return store.chats[chatId] ?? null
}

export async function createChat(input = {}) {
  return mutate((store) => {
    const id = requireKey(input.id || makeId('chat'), 'chat id')
    if (store.chats[id]) throw new Error(`chat "${id}" already exists`)
    const chat = ensureChatInStore(store, id, {
      title: input.title || id,
      profile: input.profile ?? null,
      userSlug: input.userSlug ?? null,
      status: 'idle',
    })
    if (input.taskId) linkChatToTaskInStore(store, requireKey(input.taskId, 'task id'), id)
    return chat
  })
}

export async function ensureChat(chatId, attrs = {}) {
  chatId = requireKey(chatId, 'chat id')
  return mutate((store) => ensureChatInStore(store, chatId, attrs))
}

export async function updateChat(chatId, patch = {}) {
  chatId = requireKey(chatId, 'chat id')
  return mutate((store) => {
    const chat = getChatOrThrow(store, chatId)
    if (patch.title !== undefined) chat.title = requireTitle(patch.title)
    if (patch.profile !== undefined) chat.profile = patch.profile || null
    if (patch.userSlug !== undefined) chat.userSlug = patch.userSlug || null
    if (patch.status !== undefined) chat.status = normalizeChatStatus(patch.status)
    return touch(chat)
  })
}

export async function resolveChatAlias(channelChatId) {
  channelChatId = requireKey(channelChatId, 'channel chat id')
  const store = await load()
  return store.aliases[channelChatId]?.chatId ?? channelChatId
}

export async function linkChatAlias(channelChatId, chatId, meta = {}) {
  channelChatId = requireKey(channelChatId, 'channel chat id')
  chatId = requireKey(chatId, 'chat id')
  return mutate((store) => {
    const chat = getChatOrThrow(store, chatId)
    const ts = now()
    store.aliases[channelChatId] = {
      channelChatId,
      chatId,
      channel: meta.channel ?? null,
      userSlug: meta.userSlug ?? null,
      createdAt: store.aliases[channelChatId]?.createdAt ?? ts,
      updatedAt: ts,
    }
    chat.aliases ??= []
    if (!chat.aliases.includes(channelChatId)) chat.aliases.push(channelChatId)
    return touch(chat, ts)
  })
}

export async function listAliases() {
  const store = await load()
  return sortedValues(store.aliases)
}

export async function recordRunQueued({ chatId, profile, userSlug, channel, message }) {
  chatId = requireKey(chatId, 'chat id')
  return mutate((store) => {
    const runId = makeId('run')
    const ts = now()
    const chat = ensureChatInStore(store, chatId, { profile, userSlug })
    chat.lastMessageAt = ts
    chat.queuedRunIds ??= []
    if (chat.status === 'running' && chat.currentRunId) {
      chat.queuedRunIds.push(runId)
    } else {
      chat.status = 'queued'
      chat.currentRunId = runId
    }
    chat.lastPromptPreview = preview(message, 300)
    const run = {
      id: runId,
      chatId,
      profile,
      userSlug,
      channel,
      status: 'queued',
      promptPreview: preview(message),
      events: [],
      createdAt: ts,
      updatedAt: ts,
    }
    store.runs[runId] = run
    return run
  })
}

export async function recordRunStarted(runId) {
  runId = requireKey(runId, 'run id')
  return mutate((store) => {
    const run = store.runs[runId]
    if (!run) return null
    const ts = now()
    run.status = 'running'
    run.startedAt = ts
    touch(run, ts)
    const chat = store.chats[run.chatId]
    if (chat) {
      chat.status = 'running'
      chat.currentRunId = runId
      chat.queuedRunIds = (chat.queuedRunIds ?? []).filter((id) => id !== runId)
      touch(chat, ts)
    }
    return run
  })
}

export async function recordRunEvent(runId, evt = {}) {
  runId = requireKey(runId, 'run id')
  return mutate((store) => {
    const run = store.runs[runId]
    if (!run) return null
    const ts = now()
    const event = {
      id: makeId('event'),
      runId,
      chatId: run.chatId,
      type: evt.type ?? 'event',
      name: evt.name ?? null,
      summary: preview(evt.summary, 300),
      text: preview(evt.text, 1000),
      createdAt: ts,
    }
    run.events ??= []
    run.events.push(event)
    run.lastEvent = event
    touch(run, ts)
    const chat = store.chats[run.chatId]
    if (chat) {
      chat.lastEvent = event
      touch(chat, ts)
    }
    store.events.push(event)
    if (store.events.length > EVENT_LIMIT) store.events = store.events.slice(-EVENT_LIMIT)
    return event
  })
}

export async function recordRunFinished(runId, { status, reply, error } = {}) {
  runId = requireKey(runId, 'run id')
  return mutate((store) => {
    const run = store.runs[runId]
    if (!run) return null
    const finalStatus = normalizeChatStatus(status ?? 'completed')
    const ts = now()
    run.status = finalStatus
    run.finishedAt = ts
    run.replyPreview = preview(reply)
    run.error = error ? preview(error, 1000) : null
    touch(run, ts)
    const chat = store.chats[run.chatId]
    if (chat) {
      chat.status = (chat.queuedRunIds ?? []).length > 0 ? 'queued' : finalStatus
      chat.currentRunId = null
      chat.lastRunId = runId
      chat.lastReplyPreview = run.replyPreview
      chat.lastError = run.error
      touch(chat, ts)
    }
    const runs = sortedValues(store.runs)
    if (runs.length > RUN_LIMIT) {
      for (const oldRun of runs.slice(RUN_LIMIT)) delete store.runs[oldRun.id]
    }
    return run
  })
}

export async function listRuns(filters = {}) {
  const store = await load()
  let runs = sortedValues(store.runs)
  if (filters.chatId) runs = runs.filter((r) => r.chatId === filters.chatId)
  if (filters.status) runs = runs.filter((r) => r.status === filters.status)
  return runs
}

export async function listEvents(filters = {}) {
  const store = await load()
  let events = [...store.events].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  if (filters.chatId) events = events.filter((e) => e.chatId === filters.chatId)
  if (filters.runId) events = events.filter((e) => e.runId === filters.runId)
  return events
}

export async function recordJobStarted({ profile, jobId, runId, schedule }) {
  profile = requireKey(profile, 'profile')
  jobId = requireKey(jobId, 'job id')
  return mutate((store) => {
    const key = `${profile}/${jobId}`
    const ts = now()
    const entry = store.jobRuns[key] ?? {
      key,
      profile,
      jobId,
      runCount: 0,
      createdAt: ts,
    }
    entry.status = 'running'
    entry.schedule = schedule ?? entry.schedule ?? null
    entry.lastRunId = runId ?? null
    entry.lastStartedAt = ts
    entry.runCount = (entry.runCount ?? 0) + 1
    entry.lastError = null
    store.jobRuns[key] = touch(entry, ts)
    return entry
  })
}

export async function recordJobFinished({ profile, jobId, status, reply, error }) {
  profile = requireKey(profile, 'profile')
  jobId = requireKey(jobId, 'job id')
  return mutate((store) => {
    const key = `${profile}/${jobId}`
    const ts = now()
    const entry = store.jobRuns[key] ?? {
      key,
      profile,
      jobId,
      runCount: 0,
      createdAt: ts,
    }
    entry.status = status ?? 'completed'
    entry.lastFinishedAt = ts
    entry.lastReplyPreview = preview(reply)
    entry.lastError = error ? preview(error, 1000) : null
    store.jobRuns[key] = touch(entry, ts)
    return entry
  })
}

export async function listJobRuns() {
  const store = await load()
  return sortedValues(store.jobRuns)
}

export async function snapshot() {
  const store = await load()
  return {
    projects: sortedValues(store.projects),
    tasks: sortedValues(store.tasks),
    chats: sortedValues(store.chats),
    aliases: sortedValues(store.aliases),
    runs: sortedValues(store.runs),
    jobRuns: sortedValues(store.jobRuns),
  }
}
