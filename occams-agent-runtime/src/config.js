import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..')

// Load .env from the repo root, not the cwd. This works for both
// `npm start` (cwd = occams-agent-runtime/) and systemd (cwd = repoRoot)
// and any other invocation path.
dotenv.config({ path: path.join(repoRoot, '.env') })

function bool(v, fallback = false) {
  if (v === undefined) return fallback
  return /^(1|true|yes|on)$/i.test(v.trim())
}

function defaultAgent() {
  const agent = (process.env.DEFAULT_AGENT ?? 'claude').trim().toLowerCase()
  if (agent === 'claude' || agent === 'codex') return agent
  console.warn(`[config] invalid DEFAULT_AGENT="${process.env.DEFAULT_AGENT}" — using "claude"`)
  return 'claude'
}

function timezone(name, fallback) {
  const tz = (name ?? fallback).trim()
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
    return tz
  } catch {
    console.warn(`[config] invalid timezone "${tz}" — using "${fallback}"`)
    return fallback
  }
}

export const config = {
  projectRoot,
  repoRoot,
  vaultDir: path.resolve(repoRoot, process.env.VAULT_DIR ?? './vault'),
  profilesDir: path.resolve(repoRoot, process.env.PROFILES_DIR ?? '.'),
  authDir: path.resolve(projectRoot, './auth'),
  stateFile: path.resolve(projectRoot, './state.json'),
  usersFile: path.resolve(repoRoot, process.env.USERS_FILE ?? './users.json'),
  permissionsFile: path.resolve(repoRoot, process.env.PERMISSIONS_FILE ?? './permissions.json'),
  defaultAgent: defaultAgent(),
  defaultProfile: (process.env.DEFAULT_PROFILE ?? '').trim().toLowerCase() || null,
  claude: {
    permissionMode: process.env.CLAUDE_PERMISSION_MODE ?? 'bypassPermissions',
  },
  codex: {
    sandbox: process.env.CODEX_SANDBOX ?? 'workspace-write',
    bypassApprovals: bool(process.env.CODEX_BYPASS_APPROVALS, true),
  },
  scheduler: {
    defaultTimezone: timezone(process.env.DEFAULT_TIMEZONE, 'America/New_York'),
  },
  whatsapp: {
    enabled: bool(process.env.ENABLE_WHATSAPP, true),
  },
  slack: {
    enabled: bool(process.env.ENABLE_SLACK, false),
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    sttModel: process.env.GROQ_STT_MODEL ?? 'whisper-large-v3-turbo',
  },
}
