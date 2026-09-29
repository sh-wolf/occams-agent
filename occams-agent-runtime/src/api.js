import http from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { listRunningChatIds, stopChat } from './agent.js'
import { handleMessage } from './router.js'
import { loadProfile, listProfiles } from './profiles.js'
import { listChatState, setProfileBinding } from './state.js'
import { readChatTranscript } from './transcript.js'
import { findUserBySlug, userCanUseProfile } from './users.js'
import {
  createJob,
  listAllJobs,
  makeJobId,
  removeJob,
  updateJob,
  validateCron,
} from './jobs.js'
import {
  createChat,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  ensureChat,
  getChat,
  getTask,
  linkChatAlias,
  linkChatToTask,
  listChats,
  listEvents,
  listJobRuns,
  listProjects,
  listRuns,
  listTasks,
  resolveChatAlias,
  snapshot,
  updateChat,
  updateProject,
  updateTask,
} from './registry.js'

const BODY_LIMIT = 1024 * 1024

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-agent-api-token',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  })
  res.end(text)
}

function ok(res, body = {}) {
  send(res, 200, body)
}

function noContent(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-agent-api-token',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  })
  res.end()
}

function requireAuth(req) {
  if (!config.agentApi.token) {
    throw Object.assign(new Error('AGENT_API_TOKEN is required when ENABLE_AGENT_API=true'), { status: 500 })
  }
  const auth = req.headers.authorization ?? ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  const token = bearer || req.headers['x-agent-api-token']
  if (token !== config.agentApi.token) {
    throw Object.assign(new Error('unauthorized'), { status: 401 })
  }
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    throw Object.assign(new Error(`invalid JSON: ${err.message}`), { status: 400 })
  }
}

function splitPath(url) {
  return url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
}

async function dashboardUser(slugOverride) {
  const slug = String(slugOverride || config.agentApi.userSlug || '').toLowerCase()
  if (!slug) throw Object.assign(new Error('AGENT_API_USER_SLUG is required'), { status: 500 })
  const user = await findUserBySlug(slug)
  if (!user) throw Object.assign(new Error(`No user "${slug}" in users.json`), { status: 500 })
  return user
}

async function assertProfile(profileSlug, user) {
  if (!profileSlug) return null
  const profile = await loadProfile(profileSlug)
  if (!userCanUseProfile(user, profile.slug)) {
    throw Object.assign(new Error(`User "${user.slug}" cannot use /${profile.slug}`), { status: 403 })
  }
  return profile
}

async function createDashboardChat(body) {
  const user = await dashboardUser(body.userSlug)
  const profileSlug = body.profile ? String(body.profile).toLowerCase() : null
  if (profileSlug) await assertProfile(profileSlug, user)
  const chat = await createChat({
    id: body.id,
    title: body.title,
    profile: profileSlug,
    userSlug: user.slug,
    taskId: body.taskId,
  })
  if (profileSlug) await setProfileBinding(chat.id, profileSlug)
  return chat
}

function titleForKnownChat(chatId) {
  if (chatId.startsWith('slack:')) {
    const [, channel, thread] = chatId.split(':')
    return `Slack ${channel ?? ''}${thread ? ` / ${thread}` : ''}`.trim()
  }
  if (chatId.startsWith('whatsapp:')) {
    return `WhatsApp ${chatId.slice('whatsapp:'.length).replace(/@.+$/, '')}`
  }
  if (chatId.startsWith('cron:')) {
    const [, profile, job] = chatId.split(':')
    return `Cron ${profile ?? ''}${job ? ` / ${job}` : ''}`.trim()
  }
  return chatId
}

async function syncKnownChatsFromState() {
  const running = new Set(listRunningChatIds())
  const known = await listChatState()
  for (const item of known) {
    await ensureChat(item.chatId, {
      title: titleForKnownChat(item.chatId),
      profile: item.profile,
      status: running.has(item.chatId) ? 'running' : undefined,
    })
  }
}

function safeVaultPath(rel = '') {
  const clean = path.normalize(`/${rel}`).slice(1)
  const parts = clean.split(path.sep).filter(Boolean)
  if (parts.some((p) => p === '..' || p.startsWith('.'))) {
    throw Object.assign(new Error('invalid vault path'), { status: 400 })
  }
  const abs = path.resolve(config.vaultDir, clean)
  const root = path.resolve(config.vaultDir)
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error('path escapes vault'), { status: 400 })
  }
  return { rel: clean, abs }
}

async function vaultTree(relPath, depth = 2) {
  const { rel, abs } = safeVaultPath(relPath)
  const maxDepth = Math.max(0, Math.min(Number(depth) || 2, 6))

  async function walk(currentAbs, currentRel, currentDepth) {
    const entries = await readdir(currentAbs, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) continue
      const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out.push({
          type: 'dir',
          path: childRel,
          name: entry.name,
          children: currentDepth < maxDepth ? await walk(path.join(currentAbs, entry.name), childRel, currentDepth + 1) : [],
        })
      } else if (entry.isFile()) {
        out.push({ type: 'file', path: childRel, name: entry.name })
      }
    }
    return out.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`))
  }

  return { path: rel, children: await walk(abs, rel, 0) }
}

async function vaultRecent(limit = 50) {
  const max = Math.max(1, Math.min(Number(limit) || 50, 200))
  const files = []

  async function walk(abs, rel) {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const childAbs = path.join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(childAbs, childRel)
      } else if (entry.isFile()) {
        const s = await stat(childAbs).catch(() => null)
        if (s) files.push({ path: childRel, size: s.size, mtime: s.mtime.toISOString() })
      }
    }
  }

  await walk(config.vaultDir, '')
  return files.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, max)
}

async function vaultFile(relPath) {
  const { rel, abs } = safeVaultPath(relPath)
  if (!/\.(md|json|txt)$/i.test(rel)) {
    throw Object.assign(new Error('only md/json/txt vault files are readable'), { status: 400 })
  }
  const s = await stat(abs)
  if (!s.isFile()) throw Object.assign(new Error('not a file'), { status: 400 })
  if (s.size > 512 * 1024) throw Object.assign(new Error('file too large'), { status: 413 })
  return { path: rel, text: await readFile(abs, 'utf8') }
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return noContent(res)
  requireAuth(req)

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const parts = splitPath(url)
  const body = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {}

  if (req.method === 'GET' && parts[0] === 'health') return ok(res, { ok: true })
  if (req.method === 'GET' && parts[0] === 'snapshot') {
    await syncKnownChatsFromState()
    return ok(res, await snapshot())
  }

  if (parts[0] === 'profiles' && req.method === 'GET') {
    const profiles = await listProfiles()
    return ok(res, profiles.map((p) => ({
      slug: p.slug,
      areas: p.areas,
      superuser: p.superuser,
      sandbox: p.sandbox,
    })))
  }

  if (parts[0] === 'projects') {
    if (req.method === 'GET' && parts.length === 1) return ok(res, await listProjects())
    if (req.method === 'POST' && parts.length === 1) return ok(res, await createProject(body))
    if (req.method === 'PATCH' && parts.length === 2) return ok(res, await updateProject(parts[1], body))
    if (req.method === 'DELETE' && parts.length === 2) return ok(res, await deleteProject(parts[1]))
  }

  if (parts[0] === 'tasks') {
    if (req.method === 'GET' && parts.length === 1) {
      return ok(res, await listTasks({
        projectId: url.searchParams.get('projectId'),
        status: url.searchParams.get('status'),
      }))
    }
    if (req.method === 'POST' && parts.length === 1) return ok(res, await createTask(body))
    if (req.method === 'PATCH' && parts.length === 2) return ok(res, await updateTask(parts[1], body))
    if (req.method === 'DELETE' && parts.length === 2) return ok(res, await deleteTask(parts[1]))
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'chats') {
      const task = await getTask(parts[1])
      if (!task) throw Object.assign(new Error(`unknown task "${parts[1]}"`), { status: 404 })
      if (body.chatId) return ok(res, await linkChatToTask(parts[1], body.chatId))
      return ok(res, await createDashboardChat({ ...body, taskId: parts[1], title: body.title ?? task.title }))
    }
  }

  if (parts[0] === 'chats') {
    if (req.method === 'GET' && parts.length === 1) {
      await syncKnownChatsFromState()
      return ok(res, await listChats({
        status: url.searchParams.get('status'),
        profile: url.searchParams.get('profile'),
        taskId: url.searchParams.get('taskId'),
      }))
    }
    if (req.method === 'POST' && parts.length === 1) return ok(res, await createDashboardChat(body))
    if (req.method === 'GET' && parts.length === 2) {
      const chatId = await resolveChatAlias(parts[1])
      const chat = await getChat(chatId)
      if (!chat) throw Object.assign(new Error(`unknown chat "${chatId}"`), { status: 404 })
      return ok(res, chat)
    }
    if (req.method === 'PATCH' && parts.length === 2) return ok(res, await updateChat(await resolveChatAlias(parts[1]), body))
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'aliases') {
      return ok(res, await linkChatAlias(body.channelChatId, await resolveChatAlias(parts[1]), {
        channel: body.channel,
        userSlug: body.userSlug,
      }))
    }
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'stop') {
      const chatId = await resolveChatAlias(parts[1])
      return ok(res, { stopped: stopChat(chatId), chatId })
    }
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'messages') {
      const user = await dashboardUser(body.userSlug)
      const text = String(body.text ?? '').trim()
      if (!text) throw Object.assign(new Error('text is required'), { status: 400 })
      const chatId = await resolveChatAlias(parts[1])
      const existing = await getChat(chatId)
      const requestedProfile = body.profile ? String(body.profile).toLowerCase() : null
      if (!existing && requestedProfile) await assertProfile(requestedProfile, user)
      let chat = existing ?? await ensureChat(chatId, {
        title: body.title || chatId,
        profile: requestedProfile,
        userSlug: user.slug,
      })
      if (chat && requestedProfile && !chat.profile) {
        await assertProfile(requestedProfile, user)
        chat = await updateChat(chat.id, { profile: requestedProfile, userSlug: user.slug })
      }
      if (chat.profile) {
        await assertProfile(chat.profile, user)
        await setProfileBinding(chat.id, chat.profile)
      }
      const events = []
      const reply = await handleMessage({
        text,
        chatId: chat.id,
        channel: 'dashboard',
        user,
        onEvent: (event) => events.push(event),
      })
      return ok(res, { reply, events, chat: await getChat(chat.id) })
    }
    if (req.method === 'GET' && parts.length === 3 && parts[2] === 'runs') {
      return ok(res, await listRuns({ chatId: await resolveChatAlias(parts[1]) }))
    }
    if (req.method === 'GET' && parts.length === 3 && parts[2] === 'events') {
      const chatId = await resolveChatAlias(parts[1])
      const transcript = await readChatTranscript(chatId)
      if (transcript && transcript.length > 0) return ok(res, transcript)
      // Fallback: the event store sorts newest-first; the dashboard renders a
      // top-to-bottom transcript, so hand it back oldest-first to match.
      const stored = await listEvents({ chatId })
      return ok(res, stored.slice().reverse())
    }
  }

  if (parts[0] === 'runs' && req.method === 'GET') {
    return ok(res, await listRuns({
      chatId: url.searchParams.get('chatId'),
      status: url.searchParams.get('status'),
    }))
  }

  if (parts[0] === 'jobs') {
    if (req.method === 'GET' && parts.length === 1) {
      const runsByKey = new Map((await listJobRuns()).map((r) => [r.key, r]))
      const jobs = (await listAllJobs()).map((job) => ({
        ...job,
        runtime: runsByKey.get(`${job.profile}/${job.id}`) ?? null,
      }))
      return ok(res, jobs)
    }
    if (req.method === 'POST' && parts.length === 1) {
      const user = await dashboardUser(body.userSlug)
      const profile = await assertProfile(String(body.profile ?? '').toLowerCase(), user)
      const id = body.id || makeJobId('job')
      const spec = {
        schedule: body.schedule,
        timezone: body.timezone,
        agent_cli: body.agent_cli ?? config.defaultAgent,
        prompt: body.prompt,
        deliver_to: body.deliver_to ?? 'file',
        runOnce: Boolean(body.runOnce),
      }
      if (!validateCron(spec.schedule)) throw Object.assign(new Error(`invalid cron expression: ${spec.schedule}`), { status: 400 })
      if (!spec.prompt) throw Object.assign(new Error('prompt is required'), { status: 400 })
      await createJob(profile.slug, id, spec)
      return ok(res, { profile: profile.slug, id, ...spec })
    }
    if (req.method === 'PATCH' && parts.length === 3) {
      const user = await dashboardUser(body.userSlug)
      await assertProfile(parts[1], user)
      const { userSlug: _userSlug, id: _id, profile: _profile, ...patch } = body
      const next = await updateJob(parts[1], parts[2], patch)
      return ok(res, { profile: parts[1], id: parts[2], ...next })
    }
    if (req.method === 'DELETE' && parts.length === 3) {
      const user = await dashboardUser(body.userSlug)
      await assertProfile(parts[1], user)
      await removeJob(parts[1], parts[2])
      return ok(res, { ok: true })
    }
  }

  if (parts[0] === 'vault') {
    if (req.method === 'GET' && parts[1] === 'tree') {
      return ok(res, await vaultTree(url.searchParams.get('path') ?? '', url.searchParams.get('depth') ?? 2))
    }
    if (req.method === 'GET' && parts[1] === 'recent') {
      return ok(res, await vaultRecent(url.searchParams.get('limit') ?? 50))
    }
    if (req.method === 'GET' && parts[1] === 'file') {
      return ok(res, await vaultFile(url.searchParams.get('path') ?? ''))
    }
  }

  throw Object.assign(new Error('not found'), { status: 404 })
}

export async function startAgentApi() {
  if (!config.agentApi.enabled) return null
  if (!config.agentApi.token) throw new Error('ENABLE_AGENT_API=true requires AGENT_API_TOKEN')
  if (!Number.isInteger(config.agentApi.port) || config.agentApi.port <= 0) {
    throw new Error(`Invalid AGENT_API_PORT: ${config.agentApi.port}`)
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err.status && Number.isInteger(err.status) ? err.status : 500
      if (status >= 500) console.error('[agent-api]', err)
      send(res, status, { error: err.message })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.agentApi.port, config.agentApi.host, resolve)
  })
  console.log(`[agent-api] listening on http://${config.agentApi.host}:${config.agentApi.port}`)
  return server
}
