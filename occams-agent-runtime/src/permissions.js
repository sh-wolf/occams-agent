import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

// permissions.json is the single source of truth for what each profile is
// allowed to do: which vault areas it sees, whether it's a superuser, what
// sandbox to spawn under, what env vars get injected. Profile dirs that exist
// on disk but have no entry here will not load — authority is not self-asserted
// by the agent's own role doc.
//
// Live file:    <repo-root>/permissions.json     (gitignored, admin-edited)
// Fallback:     <repo-root>/permissions.example.json (committed; used if live
//               file missing, with a loud warning at boot)

const SANDBOXES = new Set(['full', 'strict'])
const BILLINGS = new Set(['subscription', 'api'])
const SLUG_RE = /^[a-z0-9_-]+$/

let cache = null
let cachedPath = null

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

function stripComments(obj) {
  if (Array.isArray(obj)) return obj.map(stripComments)
  if (obj && typeof obj === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === '_comment') continue
      out[k] = stripComments(v)
    }
    return out
  }
  return obj
}

function validateProfile(slug, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`permissions.json: profile "${slug}" must be an object`)
  }
  if (!Array.isArray(entry.areas)) {
    throw new Error(`permissions.json: profile "${slug}".areas must be an array`)
  }
  for (const a of entry.areas) {
    if (a === '*') continue
    if (typeof a !== 'string' || !SLUG_RE.test(a)) {
      throw new Error(`permissions.json: profile "${slug}" has invalid area "${a}"`)
    }
  }
  if (typeof entry.superuser !== 'boolean') {
    throw new Error(`permissions.json: profile "${slug}".superuser must be boolean`)
  }
  const sandbox = entry.sandbox ?? 'strict'
  if (!SANDBOXES.has(sandbox)) {
    throw new Error(`permissions.json: profile "${slug}".sandbox must be one of: ${[...SANDBOXES].join(', ')}`)
  }
  const billing = entry.billing ?? 'subscription'
  if (!BILLINGS.has(billing)) {
    throw new Error(`permissions.json: profile "${slug}".billing must be one of: ${[...BILLINGS].join(', ')}`)
  }
  const env = entry.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`permissions.json: profile "${slug}".env must be an object`)
  }
  for (const [agentKey, hostKey] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(agentKey)) {
      throw new Error(`permissions.json: profile "${slug}".env key "${agentKey}" must be UPPER_SNAKE_CASE`)
    }
    if (typeof hostKey !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(hostKey)) {
      throw new Error(`permissions.json: profile "${slug}".env["${agentKey}"] must map to an UPPER_SNAKE_CASE host env var name`)
    }
  }
  // superuser implies sandbox=full (a sandboxed superuser is incoherent)
  if (entry.superuser && sandbox !== 'full') {
    throw new Error(`permissions.json: profile "${slug}" is superuser; sandbox must be "full"`)
  }
  return { areas: entry.areas, superuser: entry.superuser, sandbox, billing, env }
}

async function loadFrom(filePath) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    throw new Error(`could not read ${filePath}: ${err.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`could not parse ${filePath}: ${err.message}`)
  }
  parsed = stripComments(parsed)

  const profiles = parsed.profiles
  if (!profiles || typeof profiles !== 'object') {
    throw new Error(`${path.basename(filePath)}: missing "profiles" object`)
  }
  const out = { default: parsed.default ?? null, profiles: {} }
  for (const [slug, entry] of Object.entries(profiles)) {
    if (!SLUG_RE.test(slug)) {
      throw new Error(`${path.basename(filePath)}: invalid slug "${slug}"`)
    }
    out.profiles[slug] = validateProfile(slug, entry)
  }
  if (out.default && !out.profiles[out.default]) {
    throw new Error(`${path.basename(filePath)}: default "${out.default}" is not a defined profile`)
  }
  return out
}

export async function loadPermissions({ refresh = false } = {}) {
  if (cache && !refresh) return cache

  const live = config.permissionsFile
  const example = path.resolve(config.repoRoot, 'permissions.example.json')

  let usePath
  if (await exists(live)) {
    usePath = live
  } else if (await exists(example)) {
    console.warn(`[permissions] ${path.basename(live)} not found — using ${path.basename(example)} as fallback. Copy and customize for production use.`)
    usePath = example
  } else {
    throw new Error(`No permissions config found. Create ${live} (or ${example}).`)
  }

  cache = await loadFrom(usePath)
  cachedPath = usePath
  return cache
}

export function getPermissionsPath() {
  return cachedPath
}

export async function getProfilePermissions(slug) {
  const perms = await loadPermissions()
  return perms.profiles[slug] ?? null
}

export async function getDefaultProfileSlug() {
  const perms = await loadPermissions()
  return perms.default
}

export async function listPermittedSlugs() {
  const perms = await loadPermissions()
  return Object.keys(perms.profiles)
}
