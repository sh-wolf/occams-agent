import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises'
import path from 'node:path'
import cron from 'node-cron'
import { config } from './config.js'

const SLUG_RE = /^[a-z0-9_-]+$/i

function jobsDir(slug) {
  return path.join(config.vaultDir, 'users', slug, 'jobs')
}

function jobPath(slug, id) {
  if (!SLUG_RE.test(id)) throw new Error(`Invalid job id: ${id}`)
  return path.join(jobsDir(slug), `${id}.json`)
}

export async function listJobs(slug) {
  let files = []
  try {
    files = await readdir(jobsDir(slug))
  } catch {
    return []
  }
  const jobs = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const id = f.replace(/\.json$/, '')
    try {
      const spec = JSON.parse(await readFile(path.join(jobsDir(slug), f), 'utf8'))
      jobs.push({ id, ...spec })
    } catch (err) {
      jobs.push({ id, error: err.message })
    }
  }
  return jobs.sort((a, b) => a.id.localeCompare(b.id))
}

export async function listAllJobs() {
  let entries = []
  try {
    entries = await readdir(path.join(config.vaultDir, 'users'), { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slug = entry.name
    for (const job of await listJobs(slug)) {
      out.push({ profile: slug, ...job })
    }
  }
  return out.sort((a, b) => `${a.profile}/${a.id}`.localeCompare(`${b.profile}/${b.id}`))
}

export async function getJob(slug, id) {
  const p = jobPath(slug, id)
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No job named "${id}"`)
    throw err
  }
}

export async function removeJob(slug, id) {
  const p = jobPath(slug, id)
  try {
    await access(p)
  } catch {
    throw new Error(`No job named "${id}"`)
  }
  await unlink(p)
}

export async function createJob(slug, id, spec) {
  if (!SLUG_RE.test(id)) throw new Error(`Invalid job id: ${id}`)
  await mkdir(jobsDir(slug), { recursive: true })
  await writeFile(jobPath(slug, id), JSON.stringify(spec, null, 2) + '\n')
}

export async function updateJob(slug, id, patch) {
  const current = await getJob(slug, id)
  const next = { ...current, ...patch }
  if (!validateCron(next.schedule)) throw new Error(`Invalid cron expression: ${next.schedule}`)
  if (!next.prompt) throw new Error('Prompt is required.')
  await createJob(slug, id, next)
  return next
}

export function makeJobId(prefix = 'cron') {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${ts}-${rand}`
}

export function validateCron(expr) {
  return cron.validate(expr)
}

export function isoToCron(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return {
    expr: `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`,
    when: d,
  }
}
