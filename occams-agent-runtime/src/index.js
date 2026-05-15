import { mkdir, access } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

async function main() {
  await Promise.all([
    mkdir(path.join(config.vaultDir, 'areas'), { recursive: true }),
    mkdir(path.join(config.vaultDir, 'users'), { recursive: true }),
    mkdir(config.authDir, { recursive: true }),
  ])

  const { listProfiles } = await import('./profiles.js')
  const { getDefaultProfileSlug } = await import('./permissions.js')
  const profiles = await listProfiles()
  const defaultSlug = config.defaultProfile ?? (await getDefaultProfileSlug())
  const def = profiles.find((p) => p.slug === defaultSlug) ?? profiles[0] ?? null

  console.log('occams-agent starting')
  console.log(`  vault:     ${config.vaultDir}`)
  console.log(`  profiles:  ${config.profilesDir}`)
  console.log(`  users:     ${config.usersFile}`)
  console.log(`  default cli:     ${config.defaultAgent}`)
  console.log(`  default profile: ${def ? `/${def.slug}` : '(none)'}`)
  console.log(`  profiles found:  ${profiles.length ? profiles.map((p) => `/${p.slug}`).join(' ') : '(none — create <slug>-agent/agent-role.md)'}`)
  console.log(`  whatsapp:  ${config.whatsapp.enabled ? 'on' : 'off'}`)
  console.log(`  slack:     ${config.slack.enabled ? 'on' : 'off'}`)

  if (!(await exists(config.usersFile))) {
    console.error(`\n⚠️  ${config.usersFile} not found. Copy users.example.json to users.json and edit before any messages will be accepted.\n`)
  }
  if (profiles.length === 0) {
    console.error(`\n⚠️  No profiles found in ${config.profilesDir}. Create at least one <slug>-agent/agent-role.md before sending messages.\n`)
  }

  const channels = {}
  const channelStarts = []
  if (config.whatsapp.enabled) channelStarts.push(startChannel('whatsapp', './channels/whatsapp.js', 'startWhatsapp'))
  if (config.slack.enabled) channelStarts.push(startChannel('slack', './channels/slack.js', 'startSlack'))

  for (const [name, channel] of await Promise.all(channelStarts)) {
    channels[name] = channel
  }

  if (!channels.whatsapp && !channels.slack) {
    console.error('No channels started. Set ENABLE_WHATSAPP=true or ENABLE_SLACK=true (with valid tokens).')
    process.exit(1)
  }

  const { startScheduler } = await import('./scheduler.js')
  await startScheduler({ channels })
}

async function startChannel(name, modulePath, exportName) {
  try {
    const mod = await import(modulePath)
    return [name, await mod[exportName]()]
  } catch (err) {
    console.error(`[${name}] fatal:`, err)
    return [name, null]
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
