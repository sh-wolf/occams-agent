import { readFile, readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

let users = null

async function load() {
  if (users) return users
  try {
    const raw = await readFile(config.usersFile, 'utf8')
    const parsed = JSON.parse(raw)
    users = Array.isArray(parsed?.users) ? parsed.users : []
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`users config not found at ${config.usersFile}. Copy users.example.json to users.json and edit.`)
      users = []
    } else {
      throw new Error(`Failed to load users config: ${err.message}`)
    }
  }
  for (const u of users) {
    if (!u.slug) throw new Error(`User entry missing 'slug': ${JSON.stringify(u)}`)
    if (!/^[a-z0-9_-]+$/i.test(u.slug)) throw new Error(`Invalid slug "${u.slug}" — use alphanumerics, dashes, underscores`)
    u.whatsapp ??= []
    u.slack ??= []
    u.areas ??= []
    u.profiles ??= []
  }
  return users
}

export function userCanUseProfile(user, profileSlug) {
  if (!user) return false
  if (!Array.isArray(user.profiles) || user.profiles.length === 0) return true // unset = allow all (v1 default)
  if (user.profiles.includes('*')) return true
  return user.profiles.includes(profileSlug)
}

export async function findUserByWhatsapp(phone) {
  if (!phone) return null
  const all = await load()
  return all.find((u) => u.whatsapp.includes(phone)) ?? null
}

export async function findUserBySlack(userId) {
  if (!userId) return null
  const all = await load()
  return all.find((u) => u.slack.includes(userId)) ?? null
}

export async function findUserBySlug(slug) {
  if (!slug) return null
  const all = await load()
  return all.find((u) => u.slug === slug) ?? null
}

async function listAreasOnDisk() {
  const dir = path.join(config.vaultDir, 'areas')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export async function resolveAreas(user) {
  if (!user) return []
  if (user.areas.includes('*')) return await listAreasOnDisk()
  return user.areas.filter((a) => /^[a-z0-9_-]+$/i.test(a))
}

export async function ensureUserDir(slug) {
  const dir = path.join(config.vaultDir, 'users', slug)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function ensureAreaDirs(area) {
  const base = path.join(config.vaultDir, 'areas', area)
  await mkdir(path.join(base, 'raw'), { recursive: true })
  await mkdir(path.join(base, 'wiki'), { recursive: true })
  return base
}
