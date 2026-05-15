import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import cron from 'node-cron'
import { config } from './config.js'

const SLUG_RE = /^[a-z0-9_-]+$/i
const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function assertSlug(value, label) {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

function jobsDir(slug) {
  assertSlug(slug, 'profile slug')
  return path.join(config.vaultDir, 'users', slug, 'jobs')
}

function jobPath(slug, id) {
  assertSlug(id, 'job id')
  return path.join(jobsDir(slug), `${id}.json`)
}

export async function listJobs(slug) {
  const dir = jobsDir(slug)
  let files = []
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const jobs = await Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => {
    const id = f.slice(0, -5)
    try {
      const spec = JSON.parse(await readFile(path.join(dir, f), 'utf8'))
      return { id, ...spec }
    } catch (err) {
      return { id, error: err.message }
    }
  }))
  return jobs.sort((a, b) => a.id.localeCompare(b.id))
}

export async function removeJob(slug, id) {
  const p = jobPath(slug, id)
  try {
    await unlink(p)
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No job named "${id}"`)
    throw err
  }
}

export async function createJob(slug, id, spec) {
  const p = jobPath(slug, id)
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(spec, null, 2) + '\n')
}

export function makeJobId(prefix = 'cron') {
  assertSlug(prefix, 'job id prefix')
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14)
  const rand = randomUUID().slice(0, 8)
  return `${prefix}-${ts}-${rand}`
}

export function validateCron(expr) {
  return cron.validate(expr)
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
}

function timezoneOffsetMs(date, timezone) {
  const p = zonedParts(date, timezone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - date.getTime()
}

function zonedLocalToDate({ year, month, day, hour, minute, second = 0 }, timezone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const first = guess - timezoneOffsetMs(new Date(guess), timezone)
  const secondPass = guess - timezoneOffsetMs(new Date(first), timezone)
  return new Date(secondPass)
}

export function isoToCron(iso, timezone = config.scheduler.defaultTimezone) {
  const local = LOCAL_ISO_RE.exec(iso)
  if (local) {
    const [, year, month, day, hour, minute, second] = local
    const parts = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? 0),
    }
    const when = zonedLocalToDate(parts, timezone)
    if (Number.isNaN(when.getTime())) return null
    return {
      expr: `${parts.minute} ${parts.hour} ${parts.day} ${parts.month} *`,
      when,
    }
  }

  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = zonedParts(d, timezone)
  return {
    expr: `${p.minute} ${p.hour} ${p.day} ${p.month} *`,
    when: d,
  }
}
