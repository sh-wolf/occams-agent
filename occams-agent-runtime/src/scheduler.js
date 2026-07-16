import cron from 'node-cron'
import { readdir, readFile, unlink, mkdir, appendFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { exec } from 'node:child_process'
import path from 'node:path'
import { config } from './config.js'
import { runAgent } from './agent.js'
import { findUserBySlug } from './users.js'
import { loadProfile } from './profiles.js'
import { recordJobFinished, recordJobStarted } from './registry.js'

const tasks = new Map() // filePath -> { task, slug, spec }
const watchers = new Map() // slug -> debounce timer
let channels = {}

export async function startScheduler({ channels: ch }) {
  channels = ch

  const usersDir = path.join(config.vaultDir, 'users')
  let slugs = []
  try {
    const entries = await readdir(usersDir, { withFileTypes: true })
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch { return }

  for (const slug of slugs) {
    await scanSlug(slug)
    watchSlug(slug)
  }
  console.log(`[scheduler] active jobs: ${tasks.size}`)
}

async function scanSlug(slug) {
  const dir = path.join(config.vaultDir, 'users', slug, 'jobs')
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    files = []
  }

  const found = new Set()
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const filePath = path.join(dir, f)
    found.add(filePath)
    await registerJob(slug, filePath)
  }

  for (const [filePath, entry] of tasks) {
    if (entry.slug === slug && !found.has(filePath)) {
      entry.task.stop()
      tasks.delete(filePath)
      console.log(`[scheduler] unregistered ${path.relative(config.vaultDir, filePath)}`)
    }
  }
}

async function registerJob(slug, filePath) {
  let spec
  try {
    spec = JSON.parse(await readFile(filePath, 'utf8'))
  } catch (err) {
    console.error(`[scheduler] failed to parse ${filePath}: ${err.message}`)
    return
  }

  if (!spec.schedule || !cron.validate(spec.schedule)) {
    console.error(`[scheduler] invalid schedule in ${filePath}: ${JSON.stringify(spec.schedule)}`)
    return
  }
  if (!spec.prompt) {
    console.error(`[scheduler] missing prompt in ${filePath}`)
    return
  }

  try {
    await loadProfile(slug)
  } catch {
    console.error(`[scheduler] ${filePath}: slug "${slug}" has no profile — skipping`)
    return
  }

  const existing = tasks.get(filePath)
  if (existing) {
    if (JSON.stringify(existing.spec) === JSON.stringify(spec)) return
    existing.task.stop()
  }

  const opts = spec.timezone ? { timezone: spec.timezone } : {}
  const task = cron.schedule(spec.schedule, () => {
    // Skip if the previous invocation of THIS job is still running. node-cron
    // fires on every interval boundary regardless; without this guard a job
    // slower than its interval stacks up concurrent runs (e.g. a triage sweep
    // on a 1-min test schedule spawned ~10 overlapping sandboxes).
    const entry = tasks.get(filePath)
    if (entry?.running) {
      console.warn(`[scheduler] skip ${path.relative(config.vaultDir, filePath)} — previous run still in progress`)
      return
    }
    if (entry) entry.running = true
    fireJob(slug, filePath, spec)
      .catch((err) => {
        console.error(`[scheduler] job ${filePath} failed: ${err.message}`)
      })
      .finally(() => {
        const e = tasks.get(filePath)
        if (e) e.running = false
      })
  }, opts)

  tasks.set(filePath, { task, slug, spec, running: false })
  console.log(`[scheduler] registered ${path.relative(config.vaultDir, filePath)} (${spec.schedule}${spec.timezone ? ` ${spec.timezone}` : ''})`)
}

// Optional cheap gate: if the job declares a `precheck` shell command, run it
// before spawning the (expensive, token-burning) agent. Exit 0 -> proceed;
// non-zero -> skip this fire entirely, no agent, no registry entry. The
// scheduler stays dumb — it only inspects the exit code; all policy (what
// "nothing new" means, and crucially failing OPEN on curl/network/token
// errors so a broken precheck never silently halts the agent) lives in the
// precheck script itself, which is editable in the job JSON without a
// runtime change. Runs in the host process env, which inherits .env, so the
// precheck has the same secrets the host does.
function runPrecheck(spec, filePath) {
  if (!spec.precheck) return Promise.resolve(true)
  const rel = path.relative(config.vaultDir, filePath)
  return new Promise((resolve) => {
    exec(
      spec.precheck,
      { timeout: spec.precheck_timeout_ms ?? 20000, env: process.env, shell: '/bin/bash' },
      (err) => {
        if (!err) {
          resolve(true)
          return
        }
        // A launch/timeout failure (no numeric exit code) fails OPEN — we
        // run the agent rather than silently going dark on a broken gate.
        if (typeof err.code !== 'number') {
          console.warn(`[scheduler] precheck for ${rel} errored (${err.message}) — failing open, running agent`)
          resolve(true)
          return
        }
        console.log(`[scheduler] precheck negative for ${rel} (exit ${err.code}) — skipping fire`)
        resolve(false)
      },
    )
  })
}

async function fireJob(slug, filePath, spec) {
  console.log(`[scheduler] firing ${path.relative(config.vaultDir, filePath)}`)

  const profile = await loadProfile(slug).catch(() => null)
  if (!profile) {
    console.error(`[scheduler] no profile for ${slug} at fire time — skipping`)
    return
  }

  // Cheap pre-flight gate. Negative -> don't wake the agent at all (saves the
  // full session's tokens). A negatively-prechecked runOnce is intentionally
  // NOT consumed — it keeps waiting until its condition is met.
  if (!(await runPrecheck(spec, filePath))) return

  const jobId = path.basename(filePath, '.json')
  const chatId = `cron:${slug}:${jobId}`
  const cliAgent = spec.agent_cli ?? spec.agent ?? config.defaultAgent

  const systemUser = { slug: '__cron__', name: 'scheduled run (no human on the other end)', whatsapp: [], slack: [] }

  await recordJobStarted({ profile: slug, jobId, schedule: spec.schedule })

  let reply
  try {
    reply = await runAgent({
      cliAgent,
      profile,
      user: systemUser,
      chatId,
      message: spec.prompt,
      channel: 'cron',
      model: spec.model,
    })

    await deliver({ slug, jobId, reply, deliverTo: spec.deliver_to ?? 'file' })
    await recordJobFinished({ profile: slug, jobId, status: 'completed', reply })
  } catch (err) {
    await recordJobFinished({ profile: slug, jobId, status: 'failed', error: err.message })
    throw err
  } finally {
    // A one-shot must fire exactly once and then be gone — even if it threw.
    // Previously this lived after the try/catch, so a failing runOnce never
    // self-deleted and re-fired every interval until manually removed.
    if (spec.runOnce) {
      await unlink(filePath).catch(() => {})
      const entry = tasks.get(filePath)
      if (entry) {
        entry.task.stop()
        tasks.delete(filePath)
      }
      console.log(`[scheduler] one-shot job ${jobId} consumed`)
    }
  }
}

async function deliver({ slug, jobId, reply, deliverTo }) {
  const text = `[${slug}/${jobId}] ${reply}`

  const m = /^(whatsapp|slack):([a-z0-9_-]+)$/i.exec(deliverTo)
  if (m) {
    const [, ch, userSlug] = m
    const user = await findUserBySlug(userSlug)
    if (user) {
      const channel = channels[ch.toLowerCase()]
      const target = ch.toLowerCase() === 'whatsapp' ? user.whatsapp?.[0] : user.slack?.[0]
      if (channel && target) {
        try {
          await channel.sendDM(target, text)
          return
        } catch (err) {
          console.error(`[scheduler] ${ch} delivery to ${userSlug} failed: ${err.message}`)
        }
      } else {
        console.error(`[scheduler] missing ${ch} channel or ${ch} address for user "${userSlug}"`)
      }
    } else {
      console.error(`[scheduler] no user with slug "${userSlug}" in users.json`)
    }
  }

  // Fallback (or explicit "file"): append to the profile's jobs-output log.
  const outDir = path.join(config.vaultDir, 'users', slug, 'jobs-output')
  await mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${jobId}.md`)
  const ts = new Date().toISOString()
  await appendFile(outPath, `\n## ${ts}\n\n${reply}\n`)
  console.log(`[scheduler] filed reply to ${path.relative(config.vaultDir, outPath)}`)
}

function watchSlug(slug) {
  const dir = path.join(config.vaultDir, 'users', slug, 'jobs')
  mkdir(dir, { recursive: true })
    .then(() => {
      const watcher = watch(dir, () => {
        clearTimeout(watchers.get(slug))
        watchers.set(slug, setTimeout(() => scanSlug(slug).catch(console.error), 300))
      })
      watcher.on('error', (err) => {
        console.error(`[scheduler] watch ${slug} failed after start: ${err.message}`)
      })
    })
    .catch((err) => console.error(`[scheduler] watch ${slug} failed: ${err.message}`))
}
