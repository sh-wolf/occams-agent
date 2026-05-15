import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'

// External-repo worktrees. An agent that's granted access to an external
// repository in permissions.json's `extra_repos:` doesn't see the live
// checkout — it gets its own git worktree at:
//
//   vault/users/<slug>/worktrees/<chatId-hash>-<repo-basename>/
//
// Per (chatId, repo): distinct chats get distinct worktrees and branches,
// so a multi-turn conversation on the same chat keeps building up one
// coherent set of changes. The branch name is:
//
//   <branch_prefix or "agent/<slug>">/<chatId-hash>
//
// When the human runs /submit, the bridge (outside the sandbox, with SSH
// access) commits any pending changes, pushes the branch, and opens a PR
// via `gh`. Agents themselves never push — they can only commit locally
// inside their sandboxed worktree.

// Hash a chatId to a short stable id usable in paths + branch names.
export function chatIdHash(chatId) {
  return crypto.createHash('sha256').update(String(chatId)).digest('hex').slice(0, 8)
}

// Resolve an extra_repos entry to a concrete source path on the host.
// Entry is either { path: "/abs" } or { env: "VAR_NAME" }.
// Throws if the path can't be resolved or doesn't point at a git repo.
export function resolveSourcePath(entry) {
  let p
  if (entry.path) {
    p = entry.path
  } else if (entry.env) {
    p = process.env[entry.env]
    if (!p) {
      throw new Error(`extra_repos references env var ${entry.env} which is not set`)
    }
  } else {
    throw new Error(`extra_repos entry must declare either "path" or "env"`)
  }
  if (!path.isAbsolute(p)) {
    throw new Error(`extra_repos source path must be absolute: ${p}`)
  }
  if (!existsSync(p)) {
    throw new Error(`extra_repos source path does not exist: ${p}`)
  }
  // .git can be a dir (normal repo) or a file (worktree pointer)
  if (!existsSync(path.join(p, '.git'))) {
    throw new Error(`extra_repos source path is not a git repository: ${p}`)
  }
  return p
}

export function worktreePathFor({ profileSlug, chatId, sourcePath }) {
  const hash = chatIdHash(chatId)
  const repoName = path.basename(sourcePath)
  return path.join(config.vaultDir, 'users', profileSlug, 'worktrees', `${hash}-${repoName}`)
}

export function branchNameFor({ profileSlug, chatId, branchPrefix }) {
  const hash = chatIdHash(chatId)
  const prefix = (branchPrefix ?? `agent/${profileSlug}`).replace(/\/+$/, '')
  return `${prefix}/${hash}`
}

// Run a command and capture stdout/stderr. Throws on non-zero exit.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      } else {
        const tail = (stderr || stdout).trim().slice(-400)
        reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${tail}`))
      }
    })
  })
}

async function defaultBranchOf(sourcePath) {
  // Try origin/HEAD first; fall back to common names.
  try {
    const { stdout } = await run('git', ['-C', sourcePath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return stdout.replace(/^origin\//, '')
  } catch {
    for (const candidate of ['main', 'master']) {
      try {
        await run('git', ['-C', sourcePath, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])
        return candidate
      } catch {}
    }
    throw new Error(`could not determine default branch for ${sourcePath} — no origin/HEAD, origin/main, or origin/master`)
  }
}

// Create (or verify) a worktree for this (profile, chatId, source) tuple.
// Idempotent — safe to call on every message in a chat. Returns the worktree
// path and branch name.
export async function ensureWorktree({ profileSlug, chatId, sourcePath, branchPrefix }) {
  const wt = worktreePathFor({ profileSlug, chatId, sourcePath })
  const branch = branchNameFor({ profileSlug, chatId, branchPrefix })

  if (existsSync(wt)) {
    return { path: wt, branch, created: false }
  }

  await mkdir(path.dirname(wt), { recursive: true })

  // Fetch latest origin so we branch from current state, not a stale ref.
  try {
    await run('git', ['-C', sourcePath, 'fetch', 'origin'])
  } catch (err) {
    console.warn(`[worktrees] fetch failed for ${sourcePath} (continuing with local refs): ${err.message}`)
  }

  const defaultBranch = await defaultBranchOf(sourcePath)
  const baseRef = `origin/${defaultBranch}`

  // -B creates the branch fresh from baseRef. If a stale branch by this
  // name exists (e.g. from a previous chat with the same hash, vanishingly
  // unlikely), it gets reset — that's intentional, the worktree dir didn't
  // exist so there was no in-progress work to preserve.
  await run('git', ['-C', sourcePath, 'worktree', 'add', '-B', branch, wt, baseRef])
  console.log(`[worktrees] created ${path.basename(wt)} on branch ${branch} from ${baseRef}`)
  return { path: wt, branch, created: true }
}

// Walk an extra_repos list and return resolved entries. For mode:"pr"
// entries, this creates the worktree if it doesn't exist yet. For
// mode:"direct" entries, the live source path is used as-is. Errors
// (missing path, bad mode, broken worktree) surface here.
export async function resolveExtraRepos({ profile, chatId }) {
  const list = profile.extra_repos ?? []
  const out = []
  for (const entry of list) {
    const sourcePath = resolveSourcePath(entry)
    if (entry.mode === 'direct') {
      out.push({
        sourcePath,
        bindPath: sourcePath,
        mode: 'direct',
        branch: null,
        repoName: path.basename(sourcePath),
      })
    } else if (entry.mode === 'pr') {
      const { path: wt, branch } = await ensureWorktree({
        profileSlug: profile.slug,
        chatId,
        sourcePath,
        branchPrefix: entry.branch_prefix,
      })
      out.push({
        sourcePath,
        bindPath: wt,
        mode: 'pr',
        branch,
        repoName: path.basename(sourcePath),
      })
    } else {
      throw new Error(`extra_repos entry has invalid mode "${entry.mode}" (must be "pr" or "direct")`)
    }
  }
  return out
}

// All worktree dirs belonging to (profile, chatId).
export async function listChatWorktrees({ profileSlug, chatId }) {
  const hash = chatIdHash(chatId)
  const dir = path.join(config.vaultDir, 'users', profileSlug, 'worktrees')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(`${hash}-`))
    .map((e) => path.join(dir, e.name))
}

// Submit a worktree as a pull request. Auto-commits any pending changes,
// pushes the branch, opens a PR via `gh`. Returns { url, branch, repoName }.
// Throws if there's nothing to submit or if push/PR creation fails.
export async function submitWorktree({ worktreePath, title, slug, chatId }) {
  // 1. Capture status, auto-commit if dirty so /submit "just works"
  const { stdout: statusOut } = await run('git', ['-C', worktreePath, 'status', '--porcelain'])
  if (statusOut.length > 0) {
    await run('git', ['-C', worktreePath, 'add', '-A'])
    await run('git', ['-C', worktreePath, 'commit', '-m', `agent /${slug}: pending changes from chat ${chatId}`])
  }

  // 2. Verify we actually have commits to PR
  const { stdout: branch } = await run('git', ['-C', worktreePath, 'branch', '--show-current'])
  if (!branch) throw new Error(`worktree ${worktreePath} is not on a branch`)

  const defaultBranch = await defaultBranchOf(worktreePath)
  const { stdout: ahead } = await run('git', ['-C', worktreePath, 'rev-list', '--count', `origin/${defaultBranch}..HEAD`])
  if (parseInt(ahead, 10) === 0) {
    throw new Error(`branch ${branch} has no commits beyond origin/${defaultBranch} — nothing to submit`)
  }

  // 3. Push
  await run('git', ['-C', worktreePath, 'push', '-u', 'origin', branch])

  // 4. Open PR
  const repoName = path.basename(worktreePath).replace(/^[0-9a-f]{8}-/, '')
  const prTitle = title || `agent /${slug}: ${branch}`
  const body = [
    `Opened by the \`${slug}\` agent for chat \`${chatId}\`.`,
    '',
    `Branch: \`${branch}\``,
    `Worktree: \`vault/users/${slug}/worktrees/${path.basename(worktreePath)}\``,
  ].join('\n')

  const { stdout: prUrl } = await run('gh', ['pr', 'create',
    '--title', prTitle,
    '--body', body,
    '--base', defaultBranch,
    '--head', branch,
  ], { cwd: worktreePath })

  return { url: prUrl, branch, repoName }
}

// Remove all worktrees for (profile, chatId). Used by /forget. Idempotent.
export async function removeChatWorktrees({ profileSlug, chatId }) {
  const wts = await listChatWorktrees({ profileSlug, chatId })
  for (const wt of wts) {
    let sourceRepo
    try {
      const gitFile = await readFile(path.join(wt, '.git'), 'utf8')
      // A worktree's .git is a file: "gitdir: /path/to/source/.git/worktrees/<wt-name>"
      const m = gitFile.match(/^gitdir:\s*(.+)$/m)
      if (m) sourceRepo = path.resolve(m[1].trim(), '..', '..', '..')
    } catch {}
    if (sourceRepo) {
      try {
        await run('git', ['-C', sourceRepo, 'worktree', 'remove', '--force', wt])
        continue
      } catch (err) {
        console.warn(`[worktrees] git worktree remove failed for ${wt}: ${err.message}`)
      }
    }
    try {
      await rm(wt, { recursive: true, force: true })
    } catch (err) {
      console.warn(`[worktrees] could not rm ${wt}: ${err.message}`)
    }
  }
  return wts.length
}
