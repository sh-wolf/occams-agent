import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { readFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { config } from './config.js'
import { ensureClaudeSession, getSession, setSession } from './state.js'
import { ensureAreaDirs } from './users.js'

const SUPPORTED = new Set(['claude', 'codex'])
const DEFAULT_TIMEOUT_MS = 20 * 60_000
const STOP_GRACE_MS = 2000

// Thrown when a user runs /stop on a chat with an active subprocess. Channels
// catch this to render `(stopped)` instead of the generic `claude exited 143`.
export class StoppedError extends Error {
  constructor(message = 'stopped by user') {
    super(message)
    this.name = 'StoppedError'
  }
}

// chatId -> running ChildProcess. Populated when a subprocess is spawned and
// cleared on close. Used by stopChat() so /stop can reach into the otherwise
// chat-locked runAgent and kill the leader of its process group.
const runningProcs = new Map()

function killProcessTree(proc, signal) {
  try { process.kill(-proc.pid, signal); return } catch {}
  try { proc.kill(signal) } catch {}
}

function terminateProcessTree(proc) {
  killProcessTree(proc, 'SIGTERM')
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      killProcessTree(proc, 'SIGKILL')
    }
  }, STOP_GRACE_MS).unref()
}

function trackProc(chatId, proc) {
  runningProcs.set(chatId, proc)
  const clear = () => {
    if (runningProcs.get(chatId) === proc) runningProcs.delete(chatId)
  }
  proc.once('close', clear)
  proc.once('error', clear)
}

export function stopChat(chatId) {
  const proc = runningProcs.get(chatId)
  if (!proc || proc.killed) return false
  proc.__stoppedByUser = true
  console.log(`[agent] stopped chatId=${chatId} pid=${proc.pid}`)
  // Kill the whole process group so MCP servers, Bash tool spawns, and any
  // other descendants die too — not just the CLI leader.
  terminateProcessTree(proc)
  return true
}

// ----- Normalized event shapes emitted to onEvent -----
// Both CLIs are reduced to a small common vocabulary so channels don't have to
// know which CLI produced an event:
//   { type: 'tool_use',  name: string, summary: string }
//   { type: 'thinking',  text: string }
// Anything else in the raw stream is ignored at the channel layer.

function summarizeClaudeToolUse(block) {
  const name = block.name
  const input = block.input ?? {}
  switch (name) {
    case 'Bash':       return input.command ?? ''
    case 'Read':       return input.file_path ?? ''
    case 'Edit':       return input.file_path ?? ''
    case 'Write':      return input.file_path ?? ''
    case 'Grep':       return `${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}`
    case 'Glob':       return input.pattern ?? ''
    case 'WebFetch':   return input.url ?? ''
    case 'WebSearch':  return input.query ?? ''
    case 'TodoWrite':  return `(${(input.todos || []).length} items)`
    case 'Agent':      return input.description ?? input.subagent_type ?? ''
    default:           return ''
  }
}

function normalizeClaudeEvent(evt) {
  if (evt.type !== 'assistant' || !Array.isArray(evt.message?.content)) return []
  const out = []
  for (const block of evt.message.content) {
    if (block.type === 'thinking' && block.thinking) {
      out.push({ type: 'thinking', text: block.thinking })
    } else if (block.type === 'tool_use') {
      out.push({ type: 'tool_use', name: block.name, summary: summarizeClaudeToolUse(block) })
    }
  }
  return out
}

function normalizeCodexEvent(evt) {
  // codex --json wraps each event as { id, msg: { type, ... } }. Some older
  // builds use a `payload` wrapper instead; tolerate both.
  const msg = evt?.msg ?? evt?.payload ?? evt
  if (!msg || typeof msg !== 'object') return []
  const t = msg.type
  if (t === 'exec_command_begin') {
    const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : (msg.command ?? '')
    return [{ type: 'tool_use', name: 'shell', summary: cmd }]
  }
  if (t === 'patch_apply_begin') {
    const files = (msg.changes ?? []).map((c) => c?.path).filter(Boolean).slice(0, 3).join(', ')
    return [{ type: 'tool_use', name: 'patch', summary: files || 'apply changes' }]
  }
  if (t === 'mcp_tool_call_begin') {
    const tool = msg.invocation?.tool ?? msg.tool ?? 'mcp'
    return [{ type: 'tool_use', name: `mcp:${tool}`, summary: '' }]
  }
  if (t === 'agent_reasoning' && typeof msg.text === 'string') {
    return [{ type: 'thinking', text: msg.text }]
  }
  return []
}

function emitNormalized(onEvent, normalized) {
  if (!onEvent || normalized.length === 0) return
  for (const ne of normalized) {
    try {
      const r = onEvent(ne)
      if (r && typeof r.then === 'function') r.catch((err) => console.error('[agent] onEvent rejected:', err))
    } catch (err) {
      console.error('[agent] onEvent threw:', err)
    }
  }
}

async function ensureProfileScratch(slug) {
  const dir = path.join(config.vaultDir, 'users', slug)
  await mkdir(path.join(dir, 'jobs'), { recursive: true })
  await mkdir(path.join(dir, 'jobs-output'), { recursive: true })
  return dir
}

async function resolveAreaDirs(areas) {
  let names = areas
  if (areas.includes('*')) {
    const { readdir } = await import('node:fs/promises')
    const base = path.join(config.vaultDir, 'areas')
    try {
      const entries = await readdir(base, { withFileTypes: true })
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      names = []
    }
  }
  const dirs = []
  for (const a of names) {
    if (!/^[a-z0-9_-]+$/i.test(a)) continue
    dirs.push(await ensureAreaDirs(a))
  }
  return { areas: names, dirs }
}

async function profileDirsForAddDir(profile) {
  // Non-superuser profiles can read/write only their own profile dir.
  // Superuser (admin) gets the entire repo root: runtime code, deploy scripts,
  // all profile dirs, root config files. Equivalent scope to a human operator.
  if (!profile.superuser) return [profile.dir]
  return [config.repoRoot]
}

function bridgeContext({ user, profile, areas }) {
  const areaList = areas.length ? areas.join(', ') : '(none)'
  const lines = [
    `[bridge context]`,
    `You are the ${profile.slug} agent. The human on the other end is ${user.name ?? user.slug} (slug: ${user.slug}).`,
    `Accessible areas: ${areaList}.`,
    `Your cwd is vault/users/${profile.slug}/. Your role doc and skills live in ${path.basename(profile.dir)}/. Read its skills/ on demand.`,
  ]
  if (profile.superuser) {
    lines.push(`You are admin (superuser) — your --add-dir is the entire repo root, including runtime code, deploy scripts, and root config files. Treat .env, users.json, permissions.json, and state.json as secret-bearing files: never paste their contents into chat.`)
  } else {
    lines.push(`You may not edit other agents' profile dirs. Your authority (areas, env access, sandbox) is defined in permissions.json — you cannot see or modify that file.`)
  }
  if (profile.sandbox === 'strict' && BWRAP_PATH) {
    lines.push(`You are running inside a bubblewrap sandbox: paths outside the dirs listed above do not exist in your filesystem view. Don't waste turns trying to reach them.`)
  }
  lines.push(``, `[role]`, profile.role)
  return lines.join('\n')
}

// ----- Subprocess environment builder -----
// The host process inherits a lot of env: every key in .env, every key the
// systemd unit ships, every key the operator set in their shell. We do NOT
// pass that wholesale to subprocesses — a notes-agent shouldn't see a Slack
// bot token or another profile's API key just because they happen to live in
// the same process. The agent's env is built from scratch: a small allowlist
// of OS-required vars, optional ANTHROPIC_API_KEY per billing, and exactly
// the keys the profile declares in permissions.json's `env:` map.

const BASE_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']

function buildSubprocessEnv(profile) {
  const env = {}
  for (const k of BASE_PASSTHROUGH) {
    if (process.env[k] != null) env[k] = process.env[k]
  }
  if (profile.billing === 'api') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn(`[agent] profile /${profile.slug} requested billing=api but ANTHROPIC_API_KEY is not set`)
    } else {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    }
  }
  for (const [agentName, hostName] of Object.entries(profile.env ?? {})) {
    const val = process.env[hostName]
    if (val == null) {
      console.warn(`[agent] profile /${profile.slug} declares env ${agentName} ← ${hostName} but ${hostName} is not set in process env`)
      continue
    }
    env[agentName] = val
  }
  return env
}

// ----- Bubblewrap sandbox -----
// Strict-sandbox profiles run inside a fresh kernel namespace whose filesystem
// view contains ONLY: a read-only /usr (+ /etc) for system binaries, a fresh
// /tmp tmpfs, an empty /home with select dotdirs bound in for the agent CLI's
// own state (~/.claude, ~/.local/bin, etc.), and the read-write dirs the
// profile is granted. Everything else (`.env`, `users.json`, the repo root,
// other profile dirs, /root, /home/<other-user>) doesn't exist in the
// namespace — `cat /etc/passwd` works (it's in /etc) but `cat /home/occams/
// occams-agent/.env` fails with "no such file or directory" even from Bash,
// even from a sub-spawned process, because the path isn't there.
//
// Network is shared with the host so API calls (Anthropic, Slack, fetch)
// still work. Use a separate `--unshare-net` rule + reverse proxy if you
// also want network isolation.
//
// Linux-only. On macOS we log a warning once and run unsandboxed; Claude's
// own sandbox on darwin (sandbox-exec) is a separate mechanism we don't wire
// up here.

let bwrapWarned = false

function findBwrap() {
  if (process.platform !== 'linux') return null
  for (const p of ['/usr/bin/bwrap', '/usr/local/bin/bwrap']) {
    if (existsSync(p)) return p
  }
  return null
}

const BWRAP_PATH = findBwrap()

// Shared read-only resources that every agent legitimately needs, even when
// sandboxed. Vault CLAUDE.md/AGENTS.md are read by Claude/Codex on every turn
// via parent-walk discovery from cwd; .mcp.json registers MCP servers;
// scripts/ holds shared bash helpers; /opt/* paths host MCP server binaries
// installed system-wide. We bind whatever exists; missing entries are silently
// skipped.
function sharedReadOnlyPaths() {
  const candidates = [
    path.join(config.repoRoot, 'vault', 'CLAUDE.md'),
    path.join(config.repoRoot, 'vault', 'AGENTS.md'),
    path.join(config.repoRoot, '.mcp.json'),
    path.join(config.repoRoot, 'scripts'),
  ]
  return candidates.filter((p) => existsSync(p))
}

function bwrapPrefixArgs(allowedRwDirs) {
  const args = [
    '--unshare-all', '--share-net',
    '--die-with-parent',
    '--new-session',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/var/tmp',
    '--tmpfs', '/run',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/sbin', '/sbin',
  ]

  // HOME: tmpfs with selected dotdirs bound in so the agent CLI's own state
  // (OAuth, npm cache, installed binary) is reachable. RW so the CLI can keep
  // writing its session/cache files.
  const home = process.env.HOME
  if (home) {
    args.push('--tmpfs', home)
    for (const sub of ['.claude', '.codex', '.local/bin', '.local/share/claude', '.config/claude', '.config/codex', '.npm']) {
      const p = path.join(home, sub)
      if (existsSync(p)) args.push('--bind', p, p)
    }
  }

  for (const dir of allowedRwDirs) {
    args.push('--bind', dir, dir)
  }
  for (const ro of sharedReadOnlyPaths()) {
    args.push('--ro-bind', ro, ro)
  }

  args.push('--')
  return args
}

function wrapForSandbox(profile, allowedRwDirs, cmd, cmdArgs) {
  if (profile.sandbox === 'full' || profile.superuser) {
    return { cmd, args: cmdArgs }
  }
  if (!BWRAP_PATH) {
    if (!bwrapWarned) {
      const reason = process.platform !== 'linux'
        ? `not available on ${process.platform}`
        : 'bubblewrap not installed (sudo apt install bubblewrap)'
      console.warn(`[sandbox] strict-sandbox profiles will run UNSANDBOXED: ${reason}`)
      bwrapWarned = true
    }
    return { cmd, args: cmdArgs }
  }
  const prefix = bwrapPrefixArgs(allowedRwDirs)
  return { cmd: BWRAP_PATH, args: [...prefix, cmd, ...cmdArgs] }
}

function streamClaude(cmd, args, env, { input, cwd, timeoutMs, onEvent, chatId }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // New process group so stopChat() can SIGTERM the whole tree (MCP servers,
      // Bash tool subprocesses, etc.) via process.kill(-pid).
      detached: true,
    })
    if (chatId) trackProc(chatId, proc)

    let stderr = ''
    let finalText = ''
    let resultEvent = null
    let settled = false

    // Idle timeout: reset on every stream event. A genuinely-hung process gets
    // killed; an actively-streaming long run sails through.
    let idleTimer
    const resetIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (settled) return
        settled = true
        terminateProcessTree(proc)
        reject(new Error(`claude idle for ${timeoutMs}ms — killed`))
      }, timeoutMs)
    }
    resetIdle()

    const rl = readline.createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      resetIdle()
      let evt
      try { evt = JSON.parse(line) } catch { return }

      if (evt.type === 'result') {
        resultEvent = evt
        if (typeof evt.result === 'string') finalText = evt.result
      } else if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        // Fallback for accumulating assistant text if no result event arrives.
        for (const block of evt.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            finalText = block.text
          }
        }
      }

      emitNormalized(onEvent, normalizeClaudeEvent(evt))
    })

    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      if (err.code === 'ENOENT') {
        reject(new Error(`'claude' not found on PATH. Install it and try again.`))
      } else {
        reject(err)
      }
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      if (proc.__stoppedByUser) {
        reject(new StoppedError())
        return
      }
      if (code !== 0) {
        const tail = (stderr || '').trim().slice(-500)
        reject(new Error(`claude exited ${code}: ${tail}`))
        return
      }
      if (resultEvent?.is_error) {
        reject(new Error(`claude reported error: ${resultEvent.subtype ?? 'unknown'}`))
        return
      }
      resolve(finalText.trim())
    })

    if (input != null) proc.stdin.write(input)
    proc.stdin.end()
  })
}

async function runClaude({ profile, user, chatId, message, timeoutMs, onEvent }) {
  const cwd = await ensureProfileScratch(profile.slug)
  const { areas, dirs: areaDirs } = await resolveAreaDirs(profile.areas)
  const profileDirs = await profileDirsForAddDir(profile)
  const { id: sessionId, isNew } = await ensureClaudeSession(chatId, profile.slug)

  // First call creates the session with --session-id. Subsequent calls resume
  // it with --resume; --session-id is a "create with this UUID" flag and
  // fails if the session already exists.
  const sessionArgs = isNew
    ? ['--session-id', sessionId]
    : ['--resume', sessionId]

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    ...sessionArgs,
    '--permission-mode', config.claude.permissionMode,
    '--append-system-prompt', bridgeContext({ user, profile, areas }),
  ]
  const addDirs = [...profileDirs, ...areaDirs, cwd]
  if (addDirs.length > 0) {
    args.push('--add-dir', ...addDirs)
  }

  // Defense in depth: bubblewrap pins the kernel-level filesystem view, env
  // filtering pins what variables reach the subprocess, --add-dir pins what
  // Claude's own file tools will write to. All three say the same thing.
  const env = buildSubprocessEnv(profile)
  const { cmd, args: wrappedArgs } = wrapForSandbox(profile, addDirs, 'claude', args)

  return streamClaude(cmd, wrappedArgs, env, { input: message, cwd, timeoutMs, onEvent, chatId })
}

function pickCodexSessionId(evt) {
  // Tolerant id extraction — modern codex puts it in msg.session_id, older
  // builds use payload.session_id / payload.id / session_id at the top.
  const candidates = [
    evt?.msg?.session_id,
    evt?.payload?.session_id,
    evt?.payload?.id,
    evt?.session_id,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && /^[0-9a-f-]{36}$/i.test(c)) return c
  }
  return null
}

function streamCodex(cmd, args, env, { input, cwd, timeoutMs, onEvent, chatId }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    if (chatId) trackProc(chatId, proc)

    let stderr = ''
    let sessionId = null
    let settled = false

    let idleTimer
    const resetIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (settled) return
        settled = true
        terminateProcessTree(proc)
        reject(new Error(`codex idle for ${timeoutMs}ms — killed`))
      }, timeoutMs)
    }
    resetIdle()

    const rl = readline.createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      resetIdle()
      let evt
      try { evt = JSON.parse(line) } catch { return }

      if (!sessionId) {
        const candidate = pickCodexSessionId(evt)
        if (candidate) sessionId = candidate
      }
      emitNormalized(onEvent, normalizeCodexEvent(evt))
    })

    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      if (err.code === 'ENOENT') {
        reject(new Error(`'codex' not found on PATH. Install it and try again.`))
      } else {
        reject(err)
      }
    })

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      if (proc.__stoppedByUser) {
        reject(new StoppedError())
        return
      }
      if (code !== 0) {
        const tail = (stderr || '').trim().slice(-500)
        reject(new Error(`codex exited ${code}: ${tail}`))
        return
      }
      resolve({ sessionId })
    })

    if (input != null) proc.stdin.write(input)
    proc.stdin.end()
  })
}

async function runCodex({ profile, user, chatId, message, timeoutMs, onEvent }) {
  const cwd = await ensureProfileScratch(profile.slug)
  const { areas, dirs: areaDirs } = await resolveAreaDirs(profile.areas)
  const profileDirs = await profileDirsForAddDir(profile)
  const replyFile = path.join(os.tmpdir(), `codex-reply-${randomUUID()}.txt`)
  const existing = await getSession(chatId, profile.slug, 'codex')

  const baseArgs = [
    '--json',
    '-o', replyFile,
    '--skip-git-repo-check',
  ]
  if (config.codex.bypassApprovals) {
    baseArgs.push('-c', 'approval_policy="never"')
  }
  for (const dir of [...profileDirs, ...areaDirs]) {
    baseArgs.push('--add-dir', dir)
  }

  // Codex has its own kernel-level sandbox (seatbelt/landlock) controlled via
  // --sandbox. We leave it at workspace-write so the agent can write to its
  // scratch + areas; bwrap is what enforces what "workspace" looks like in
  // the namespace for strict-sandbox profiles.
  let args
  if (existing) {
    args = ['exec', 'resume', existing, ...baseArgs, '-']
  } else {
    args = ['exec', ...baseArgs, '--sandbox', config.codex.sandbox, '-']
  }

  const stdinPayload = existing
    ? message
    : `${bridgeContext({ user, profile, areas })}\n\n${message}`

  const env = buildSubprocessEnv(profile)
  const rwDirs = [...profileDirs, ...areaDirs, cwd, path.dirname(replyFile)]
  const { cmd, args: wrappedArgs } = wrapForSandbox(profile, rwDirs, 'codex', args)

  try {
    const { sessionId } = await streamCodex(cmd, wrappedArgs, env, {
      input: stdinPayload,
      cwd,
      timeoutMs,
      onEvent,
      chatId,
    })

    if (!existing) {
      if (sessionId) await setSession(chatId, profile.slug, 'codex', sessionId)
      else console.warn('[codex] could not extract session id from output')
    }

    const reply = await readFile(replyFile, 'utf8').catch(() => '')
    return reply.trim()
  } finally {
    await unlink(replyFile).catch(() => {})
  }
}

// Per-chat serialization. claude/codex hold an exclusive lock on a session UUID
// while a subprocess is running, so concurrent messages on the same chat will
// fail with "Session ID is already in use". Queue them through a Promise chain
// per chatId.
const chatLocks = new Map()

function withChatLock(key, fn) {
  const prev = chatLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const stored = next.finally(() => {
    if (chatLocks.get(key) === stored) chatLocks.delete(key)
  })
  chatLocks.set(key, stored)
  return next
}

export async function runAgent({ cliAgent, profile, user, chatId, message, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent }) {
  if (!SUPPORTED.has(cliAgent)) {
    throw new Error(`Unknown CLI agent "${cliAgent}". Use one of: ${[...SUPPORTED].join(', ')}`)
  }
  if (!profile) throw new Error('runAgent: profile is required')
  if (!chatId) throw new Error('runAgent: chatId is required')
  if (!user) throw new Error('runAgent: user is required')

  return withChatLock(chatId, () => {
    if (cliAgent === 'claude') return runClaude({ profile, user, chatId, message, timeoutMs, onEvent })
    if (cliAgent === 'codex')  return runCodex({  profile, user, chatId, message, timeoutMs, onEvent })
  })
}
