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

// Extra absolute paths to bind read-only into every strict-sandbox profile
// (e.g. a host-installed MCP server binary). Comma-separated; missing paths
// are silently skipped at bind time.
function sharedBindPaths() {
  return (process.env.SHARED_BIND_PATHS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

export const config = {
  projectRoot,
  repoRoot,
  vaultDir: path.resolve(repoRoot, process.env.VAULT_DIR ?? './vault'),
  profilesDir: path.resolve(repoRoot, process.env.PROFILES_DIR ?? '.'),
  authDir: path.resolve(projectRoot, './auth'),
  runtimeDataDir: path.resolve(projectRoot, process.env.RUNTIME_DATA_DIR ?? './runtime-data'),
  stateFile: path.resolve(projectRoot, './state.json'),
  usersFile: path.resolve(repoRoot, process.env.USERS_FILE ?? './users.json'),
  permissionsFile: path.resolve(repoRoot, process.env.PERMISSIONS_FILE ?? './permissions.json'),
  defaultAgent: defaultAgent(),
  defaultProfile: (process.env.DEFAULT_PROFILE ?? '').trim().toLowerCase() || null,
  sharedBindPaths: sharedBindPaths(),
  claude: {
    permissionMode: process.env.CLAUDE_PERMISSION_MODE ?? 'bypassPermissions',
  },
  codex: {
    sandbox: process.env.CODEX_SANDBOX ?? 'workspace-write',
    bypassApprovals: bool(process.env.CODEX_BYPASS_APPROVALS, true),
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
  agentApi: {
    enabled: bool(process.env.ENABLE_AGENT_API, false),
    host: process.env.AGENT_API_HOST ?? '127.0.0.1',
    port: Number(process.env.AGENT_API_PORT ?? 8787),
    token: process.env.AGENT_API_TOKEN ?? '',
    userSlug: (process.env.AGENT_API_USER_SLUG ?? '').toLowerCase(),
  },
  // Generic inbound webhook (opt-in, disabled by default). Lets an external
  // service trigger ONE stateless agent run per verified request. Auth is two
  // mandatory, fail-closed, constant-time gates: an unguessable URL path
  // secret AND an HMAC signature over the raw body. Binds 127.0.0.1 only —
  // public reach is the operator's reverse proxy / tunnel to arrange. See
  // webhook.js for the full security model.
  webhook: {
    enabled: bool(process.env.ENABLE_WEBHOOK, false),
    port: Number(process.env.WEBHOOK_PORT ?? 8788),
    // Unguessable extra path segment: POST to /hook/<WEBHOOK_PATH_SECRET>.
    pathSecret: process.env.WEBHOOK_PATH_SECRET ?? '',
    // Shared secret the sender HMACs the raw body with.
    signingSecret: process.env.WEBHOOK_SECRET ?? '',
    // Header carrying the signature, its hash algo, and the value's prefix.
    // Defaults suit a `sha256=<hex>` style; tune per provider.
    signatureHeader: (process.env.WEBHOOK_SIGNATURE_HEADER ?? 'x-signature').toLowerCase(),
    signatureAlgo: process.env.WEBHOOK_SIGNATURE_ALGO ?? 'sha256',
    signaturePrefix: process.env.WEBHOOK_SIGNATURE_PREFIX ?? 'sha256=',
    // Profile whose sandbox/permissions the triggered run uses (required).
    profile: (process.env.WEBHOOK_PROFILE ?? '').trim().toLowerCase(),
    maxConcurrent: Number(process.env.WEBHOOK_MAX_CONCURRENT ?? 4),
  },
}
