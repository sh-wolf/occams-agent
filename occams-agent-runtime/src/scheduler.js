import cron from 'node-cron'
import { readdir, readFile, unlink, mkdir, appendFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { runAgent } from './agent.js'
import { findUserBySlug } from './users.js'
import { loadProfile } from './profiles.js'

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

  const timezone = spec.timezone ?? config.scheduler.defaultTimezone
  const opts = { timezone }
  const task = cron.schedule(spec.schedule, () => {
    fireJob(slug, filePath, spec).catch((err) => {
      console.error(`[scheduler] job ${filePath} failed: ${err.message}`)
    })
  }, opts)

  tasks.set(filePath, { task, slug, spec })
  console.log(`[scheduler] registered ${path.relative(config.vaultDir, filePath)} (${spec.schedule} ${timezone})`)
}

async function fireJob(slug, filePath, spec) {
  console.log(`[scheduler] firing ${path.relative(config.vaultDir, filePath)}`)

  const profile = await loadProfile(slug).catch(() => null)
  if (!profile) {
    console.error(`[scheduler] no profile for ${slug} at fire time — skipping`)
    return
  }

  const jobId = path.basename(filePath, '.json')
  const chatId = `cron:${slug}:${jobId}`
  const cliAgent = spec.agent_cli ?? spec.agent ?? config.defaultAgent

  const systemUser = { slug: '__cron__', name: 'scheduled run (no human on the other end)', whatsapp: [], slack: [] }

  const reply = await runAgent({
    cliAgent,
    profile,
    user: systemUser,
    chatId,
    message: spec.prompt,
  })

  await deliver({ slug, jobId, reply, deliverTo: spec.deliver_to ?? 'file' })

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
      watch(dir, () => {
        clearTimeout(watchers.get(slug))
        watchers.set(slug, setTimeout(() => scanSlug(slug).catch(console.error), 300))
      })
    })
    .catch((err) => console.error(`[scheduler] watch ${slug} failed: ${err.message}`))
}
