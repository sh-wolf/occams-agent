import { config } from './config.js'
import { runAgent, stopChat } from './agent.js'
import {
  clearChat,
  clearChatSessions,
  getProfileBinding,
  setProfileBinding,
  getChatStreaming,
  setChatStreaming,
} from './state.js'
import { listProfiles, getDefaultProfile } from './profiles.js'
import { userCanUseProfile } from './users.js'
import {
  listJobs,
  removeJob,
  createJob,
  makeJobId,
  validateCron,
  isoToCron,
} from './jobs.js'

const RUNTIME_PREFIXES = new Set([
  'help', 'whoami', 'profiles', 'reset', 'new', 'forget',
  'jobs', 'cron', 'claude', 'codex', 'streaming', 'stop',
])

function parseMessage(text, profileSlugs) {
  let trimmed = (text ?? '').trim()
  if (!trimmed) return { kind: 'empty' }

  // Optional leading profile prefix, e.g. "/marketing ..."
  let profileOverride = null
  const profMatch = /^\/([a-z0-9_-]+)(\s|$)/i.exec(trimmed)
  if (profMatch) {
    const slug = profMatch[1].toLowerCase()
    if (profileSlugs.has(slug) && !RUNTIME_PREFIXES.has(slug)) {
      profileOverride = slug
      trimmed = trimmed.slice(profMatch[0].length).trim()
      if (!trimmed) return { kind: 'agent', cliAgent: null, message: '', profileOverride }
    }
  }

  if (/^\/help\b/i.test(trimmed)) return { kind: 'help' }
  if (/^\/whoami\b/i.test(trimmed)) return { kind: 'whoami', profileOverride }
  if (/^\/profiles\b/i.test(trimmed)) return { kind: 'profiles' }
  if (/^\/(reset|new)\b/i.test(trimmed)) return { kind: 'reset', profileOverride }
  if (/^\/forget\b/i.test(trimmed)) return { kind: 'forget' }
  if (/^\/jobs\b/i.test(trimmed)) {
    return { kind: 'jobs', rest: trimmed.replace(/^\/jobs\s*/i, '').trim(), profileOverride }
  }
  if (/^\/cron\b/i.test(trimmed)) {
    return { kind: 'cron', rest: trimmed.replace(/^\/cron\s*/i, '').trim(), profileOverride }
  }
  if (/^\/streaming\b/i.test(trimmed)) {
    return { kind: 'streaming', rest: trimmed.replace(/^\/streaming\s*/i, '').trim() }
  }
  // /stop must dispatch OUTSIDE runAgent — see handleMessage. Don't move this
  // into the agent path or it'll queue behind the very process it's killing.
  if (/^\/stop\b/i.test(trimmed)) return { kind: 'stop' }

  let cliAgent = null
  if (/^\/claude\b/i.test(trimmed)) {
    cliAgent = 'claude'
    trimmed = trimmed.replace(/^\/claude\s*/i, '').trim()
  } else if (/^\/codex\b/i.test(trimmed)) {
    cliAgent = 'codex'
    trimmed = trimmed.replace(/^\/codex\s*/i, '').trim()
  }

  return { kind: 'agent', cliAgent, message: trimmed, profileOverride }
}

function formatProfiles(profiles, currentSlug) {
  if (profiles.length === 0) return 'No profiles found. Create a `<slug>-agent/agent-role.md` file at the repo root.'
  const lines = ['Available profiles:']
  for (const p of profiles) {
    const marker = p.slug === currentSlug ? ' ← current' : p.default ? ' (default)' : ''
    const su = p.superuser ? ' [superuser]' : ''
    lines.push(`  /${p.slug}${su}${marker}`)
  }
  lines.push('', 'Send `/<slug>` to bind this chat to a profile.')
  return lines.join('\n')
}

function formatWhoami(user, profile, profiles) {
  const lines = [
    `${user.name ?? user.slug} (slug: ${user.slug})`,
    `This chat is bound to: ${profile ? `/${profile.slug}` : '(none — set with /<slug>)'}`,
  ]
  if (profile) {
    const areas = profile.areas.length ? profile.areas.join(', ') : '(none)'
    lines.push(`Areas for this profile: ${areas}`)
  }
  const others = profiles.filter((p) => !profile || p.slug !== profile.slug).map((p) => `/${p.slug}`).join(' ')
  if (others) lines.push(`Other profiles: ${others}`)
  return lines.join('\n')
}

const HELP_TEXT = [
  'Commands:',
  '  /<profile-slug> [msg]  — bind this chat to that agent (sticky); optional first message',
  '  /profiles              — list available profiles',
  '  /whoami                — show your identity and which profile this chat is bound to',
  '  /new                   — clear conversation history (keeps profile)',
  '  /forget                — wipe this chat entirely (profile binding + history)',
  '  /jobs                  — list scheduled jobs for the current profile',
  '  /jobs rm <id>          — delete a scheduled job',
  '  /cron <m h dom mo dow> <prompt>',
  '                         — schedule a recurring job under the current profile',
  '  /cron once <ISO datetime> <prompt>',
  '                         — schedule a one-shot job',
  '  /claude <msg>          — one-shot: use Claude regardless of default',
  '  /codex <msg>           — one-shot: use Codex regardless of default',
  '  /streaming [on|off]    — show or hide the live tool-call trace in this chat',
  '  /stop                  — stop the agent turn that\'s running for this chat. Doesn\'t drain queued messages.',
  '  /help                  — this message',
  '',
  'Plain messages route to the chat\'s bound profile. Switch with /<other-slug>.',
  `Default CLI: ${config.defaultAgent}`,
].join('\n')

async function resolveProfile(parsed, chatId, profiles) {
  if (parsed.profileOverride) {
    const profile = profiles.find((p) => p.slug === parsed.profileOverride)
    if (!profile) return null
    await setProfileBinding(chatId, profile.slug)
    return profile
  }
  const bound = await getProfileBinding(chatId)
  if (bound) {
    const p = profiles.find((x) => x.slug === bound)
    if (p) return p
  }
  return getDefaultProfile()
}

function defaultDeliveryFor(user, channel) {
  if (channel === 'whatsapp' && user.whatsapp?.[0]) return `whatsapp:${user.slug}`
  if (channel === 'slack' && user.slack?.[0]) return `slack:${user.slug}`
  return 'file'
}

async function handleStreamingCommand({ chatId, rest }) {
  const current = await getChatStreaming(chatId)
  if (!rest) {
    return `Streaming is ${current ? 'on' : 'off'} for this chat. Toggle with \`/streaming on\` or \`/streaming off\`.`
  }
  if (/^(on|true|1|yes)$/i.test(rest)) {
    await setChatStreaming(chatId, true)
    return 'Streaming on — you\'ll see tool calls live as the agent works.'
  }
  if (/^(off|false|0|no)$/i.test(rest)) {
    await setChatStreaming(chatId, false)
    return 'Streaming off — only the final answer will be shown.'
  }
  return 'Usage: `/streaming on` or `/streaming off`. Send `/streaming` alone to see the current setting.'
}

async function handleJobsCommand({ profile, rest }) {
  if (!rest) {
    const jobs = await listJobs(profile.slug)
    if (jobs.length === 0) return `No active jobs for /${profile.slug}.`
    const lines = [`Active jobs for /${profile.slug} (${jobs.length}):`, '']
    for (const j of jobs) {
      if (j.error) { lines.push(`• ${j.id}: ⚠️ ${j.error}`); continue }
      const snippet = (j.prompt ?? '').slice(0, 60) + ((j.prompt ?? '').length > 60 ? '…' : '')
      const tz = ` ${j.timezone ?? config.scheduler.defaultTimezone}`
      const once = j.runOnce ? ' (once)' : ''
      const cli = j.agent_cli ?? j.agent ?? config.defaultAgent
      lines.push(
        `• ${j.id}`,
        `    ${j.schedule}${tz}${once} → ${j.deliver_to ?? 'file'} via ${cli}`,
        `    "${snippet}"`,
      )
    }
    return lines.join('\n')
  }
  const rm = /^(rm|delete|del|remove)\s+(\S+)$/i.exec(rest)
  if (rm) {
    try {
      await removeJob(profile.slug, rm[2])
      return `Removed ${rm[2]} from /${profile.slug}.`
    } catch (err) {
      return `⚠️ ${err.message}`
    }
  }
  return 'Usage: `/jobs` or `/jobs rm <id>`'
}

async function handleCronCommand({ profile, user, channel, rest }) {
  if (!rest) {
    return 'Usage: `/cron <m h dom mo dow> <prompt>` or `/cron once <ISO datetime> <prompt>`'
  }
  const deliverTo = defaultDeliveryFor(user, channel)
  let spec
  if (/^once\s/i.test(rest)) {
    const m = /^once\s+(\S+)\s+(.+)$/is.exec(rest)
    if (!m) return 'Usage: `/cron once <YYYY-MM-DDTHH:MM> <prompt>`'
    const parsed = isoToCron(m[1], config.scheduler.defaultTimezone)
    if (!parsed) return `Couldn't parse "${m[1]}" as a datetime. Try ISO format like 2026-05-12T15:00.`
    if (parsed.when < new Date()) return `That time is in the past (${parsed.when.toISOString()}).`
    spec = {
      schedule: parsed.expr,
      agent_cli: config.defaultAgent,
      prompt: m[2].trim(),
      deliver_to: deliverTo,
      runOnce: true,
      timezone: config.scheduler.defaultTimezone,
    }
  } else {
    const tokens = rest.split(/\s+/)
    if (tokens.length < 6) return 'Usage: `/cron <m> <h> <dom> <mo> <dow> <prompt>`'
    const expr = tokens.slice(0, 5).join(' ')
    if (!validateCron(expr)) return `Invalid cron expression: \`${expr}\``
    const prompt = tokens.slice(5).join(' ').trim()
    if (!prompt) return 'Prompt is required after the cron expression.'
    spec = {
      schedule: expr,
      agent_cli: config.defaultAgent,
      prompt,
      deliver_to: deliverTo,
      runOnce: false,
      timezone: config.scheduler.defaultTimezone,
    }
  }

  const id = makeJobId()
  await createJob(profile.slug, id, spec)
  return `Scheduled ${id} under /${profile.slug}: \`${spec.schedule}\`${spec.runOnce ? ' (once)' : ''} ${spec.timezone} → ${spec.deliver_to}`
}

export async function handleMessage({ text, chatId, channel, user, onEvent }) {
  const profiles = await listProfiles()
  const profileSlugs = new Set(profiles.map((p) => p.slug))
  const parsed = parseMessage(text, profileSlugs)

  if (parsed.kind === 'empty') return 'Empty message. Send `/help` for commands.'
  if (parsed.kind === 'help') return HELP_TEXT
  if (parsed.kind === 'profiles') {
    const bound = await getProfileBinding(chatId)
    return formatProfiles(profiles, bound)
  }
  if (parsed.kind === 'forget') {
    const had = await clearChat(chatId)
    return had ? 'Wiped this chat — profile and history.' : 'Nothing to forget.'
  }
  if (parsed.kind === 'streaming') return handleStreamingCommand({ chatId, rest: parsed.rest })
  // Routed before resolveProfile/runAgent on purpose: the chat lock in runAgent
  // is held by the very process we're trying to kill, so /stop must never enter
  // that path. See parseMessage for the matching note.
  if (parsed.kind === 'stop') {
    const stopped = stopChat(chatId)
    return stopped ? 'Stopped.' : 'Nothing to stop.'
  }

  const profile = await resolveProfile(parsed, chatId, profiles)
  if (!profile) {
    return 'No profile selected for this chat. Send `/profiles` to see options, then `/<slug>` to bind.'
  }
  if (!userCanUseProfile(user, profile.slug)) {
    return `You don't have access to /${profile.slug}. Send /profiles to see what you can use.`
  }

  if (parsed.kind === 'whoami') return formatWhoami(user, profile, profiles)
  if (parsed.kind === 'reset') {
    const had = await clearChatSessions(chatId)
    return had
      ? `Cleared conversation history. Still talking to /${profile.slug}.`
      : `No conversation history to clear. Still talking to /${profile.slug}.`
  }
  if (parsed.kind === 'jobs') return handleJobsCommand({ profile, rest: parsed.rest })
  if (parsed.kind === 'cron') return handleCronCommand({ profile, user, channel, rest: parsed.rest })

  if (!parsed.message) {
    return `This chat is bound to /${profile.slug}. Send a message to start.`
  }

  const cliAgent = parsed.cliAgent ?? config.defaultAgent
  console.log(`[${channel}] ${user.slug}@${chatId} -> /${profile.slug} via ${cliAgent}: ${parsed.message.slice(0, 80)}`)
  try {
    const reply = await runAgent({
      cliAgent,
      profile,
      user,
      chatId,
      message: parsed.message,
      onEvent,
    })
    return reply || '(no output)'
  } catch (err) {
    // Let StoppedError bubble up so channels can render `(stopped)` cleanly
    // instead of showing the generic exit-code warning.
    if (err.name === 'StoppedError') throw err
    console.error(`[${channel}] /${profile.slug} via ${cliAgent} error:`, err.message)
    return `⚠️ /${profile.slug} (${cliAgent}) failed: ${err.message}`
  }
}
