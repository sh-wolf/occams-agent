import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import {
  loadPermissions,
  getProfilePermissions,
  getDefaultProfileSlug,
} from './permissions.js'

// A "profile" is a (<slug>-agent/agent-role.md, permissions.json entry) pair.
// The role doc supplies the system prompt body; permissions.json supplies all
// authority (areas, superuser, sandbox, billing, env). A profile dir without a
// matching permissions entry will NOT load — authority is not self-asserted.

const SLUG_RE = /^[a-z0-9_-]+$/

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rawVal] = kv
    const val = rawVal.trim()
    if (val === 'true') meta[key] = true
    else if (val === 'false') meta[key] = false
    else if (val === '' || val === '~' || val === 'null') meta[key] = null
    else meta[key] = val.replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2].trim() }
}

async function loadRole(dir, slug) {
  const rolePath = path.join(dir, 'agent-role.md')
  const text = await readFile(rolePath, 'utf8')
  const { meta, body } = parseFrontmatter(text)
  // We only honor `slug:` for validation; everything else in frontmatter is
  // descriptive (e.g. `description:`). All authority comes from permissions.json.
  const declaredSlug = meta.slug ?? slug
  if (declaredSlug !== slug) {
    throw new Error(`profile ${slug}: frontmatter slug "${declaredSlug}" does not match directory name`)
  }
  return body
}

async function buildProfile(slug, dir, perms) {
  const role = await loadRole(dir, slug)
  return {
    slug,
    dir,
    role,
    // authority — from permissions.json, never from frontmatter
    areas: perms.areas,
    superuser: perms.superuser,
    sandbox: perms.sandbox,
    billing: perms.billing,
    env: perms.env,
  }
}

export async function loadProfile(slug) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid profile slug "${slug}"`)
  }
  const perms = await getProfilePermissions(slug)
  if (!perms) {
    throw new Error(`profile "${slug}" has no entry in permissions.json`)
  }
  const dir = path.join(config.profilesDir, `${slug}-agent`)
  return buildProfile(slug, dir, perms)
}

export async function listProfiles() {
  const allPerms = await loadPermissions()
  let entries
  try {
    entries = await readdir(config.profilesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const onDisk = new Map()
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = /^(.+)-agent$/.exec(e.name)
    if (!m) continue
    onDisk.set(m[1], path.join(config.profilesDir, e.name))
  }

  const profiles = []
  for (const [slug, perms] of Object.entries(allPerms.profiles)) {
    const dir = onDisk.get(slug)
    if (!dir) {
      console.warn(`[profiles] "${slug}" is in permissions.json but ${slug}-agent/ does not exist on disk — skipping`)
      continue
    }
    try {
      profiles.push(await buildProfile(slug, dir, perms))
    } catch (err) {
      console.warn(`[profiles] could not load "${slug}": ${err.message}`)
    }
  }
  // Warn about profile dirs that exist but have no permissions entry — the
  // common case is "admin forgot to add this profile to permissions.json"
  for (const [slug] of onDisk) {
    if (!allPerms.profiles[slug]) {
      console.warn(`[profiles] ${slug}-agent/ exists on disk but has no permissions.json entry — not loaded`)
    }
  }
  return profiles
}

export async function getDefaultProfile() {
  const explicit = config.defaultProfile ?? (await getDefaultProfileSlug())
  if (explicit) {
    try {
      return await loadProfile(explicit)
    } catch {
      // fall through
    }
  }
  const all = await listProfiles()
  return all[0] ?? null
}

export async function listProfileSlugs() {
  return (await listProfiles()).map((p) => p.slug)
}
