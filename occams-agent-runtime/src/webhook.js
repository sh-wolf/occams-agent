// Generic inbound webhook listener — deliberately the smallest, dumbest
// public surface in the system.
//
// SECURITY MODEL (read before changing anything here):
//   * Binds 127.0.0.1 on its OWN port. It is meant to sit behind a reverse
//     proxy / tunnel that terminates TLS and forwards to it. Nothing here
//     should ever bind a wide interface.
//   * It can do exactly ONE thing: on a verified request, spawn ONE stateless
//     agent run under a single preconfigured profile. It cannot read the
//     vault, choose an arbitrary profile, or touch jobs — the request body
//     only becomes prompt text for that fixed profile's run.
//   * Two independent gates, BOTH mandatory and fail-closed, BOTH compared in
//     constant time:
//       1. An unguessable URL path secret (defends the public URL itself).
//       2. An HMAC signature over the RAW body, keyed by WEBHOOK_SECRET.
//     Either failing => 404/401 and no work happens. There is no fail-open
//     path anywhere in this file.
//   * The request body is size-capped before we read it, so an unauthenticated
//     caller cannot exhaust memory.
//
// Stateless-per-request by design: a fresh agent session every time (unique
// chatId), so the run never resumes stale context. The profile's role/skills
// define what the run actually does with the payload.

import http from 'node:http'
import crypto from 'node:crypto'
import { config } from './config.js'
import { loadProfile } from './profiles.js'
import { runAgent } from './agent.js'

const BODY_LIMIT = 256 * 1024

// The spawned run is sessionless — this prompt is the ONLY context it gets,
// so it must be self-contained. The profile's own role/skills are the
// behavioral contract; we just hand it the verified payload.
function promptFor(rawBody) {
  return [
    'You were triggered by a verified inbound webhook. The raw JSON payload',
    'follows. Act on it according to your role and skills.',
    '',
    '```json',
    rawBody.toString('utf8').slice(0, 8000),
    '```',
  ].join('\n')
}

function timingSafeEqualStr(a, b) {
  // timingSafeEqual throws on length mismatch; hash to a fixed length first
  // so the comparison itself never leaks length via an early throw.
  const ha = crypto.createHash('sha256').update(Buffer.from(String(a))).digest()
  const hb = crypto.createHash('sha256').update(Buffer.from(String(b))).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function verifySignature(rawBody, header) {
  if (!header) return false
  const { signingSecret, signatureAlgo, signaturePrefix } = config.webhook
  let expected
  try {
    expected = signaturePrefix + crypto.createHmac(signatureAlgo, signingSecret).update(rawBody).digest('hex')
  } catch {
    return false // bad algo name => reject, never throw past the gate
  }
  return timingSafeEqualStr(header, expected)
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Global concurrency cap so a burst of verified requests can't fork unbounded
// agent runs. Excess requests are acked (200) but dropped — the sender holds
// the secret, so this is backpressure, not a security boundary.
let inFlight = 0

async function runWebhook(rawBody) {
  if (inFlight >= config.webhook.maxConcurrent) {
    console.warn(`[webhook] concurrency cap (${config.webhook.maxConcurrent}) hit — dropping this delivery`)
    return
  }
  inFlight++
  try {
    const profile = await loadProfile(config.webhook.profile)
    if (!profile) {
      console.error(`[webhook] WEBHOOK_PROFILE="${config.webhook.profile}" not found — dropping delivery`)
      return
    }
    const systemUser = { slug: '__webhook__', name: 'inbound webhook (no human on the other end)', whatsapp: [], slack: [] }
    await runAgent({
      cliAgent: config.defaultAgent,
      profile,
      user: systemUser,
      // Unique per run => a FRESH session every time (never --resume), so
      // skill/role edits always take effect and context can't bloat.
      chatId: `webhook:${profile.slug}:${Date.now()}`,
      message: promptFor(rawBody),
      channel: 'webhook',
    })
    console.log(`[webhook] run completed under /${profile.slug}`)
  } catch (err) {
    console.error(`[webhook] run failed: ${err.message}`)
  } finally {
    inFlight--
  }
}

async function route(req, res) {
  // Valid path: /hook/<pathSecret>. Anything else is a bare 404 — don't
  // confirm the path shape to a prober.
  const url = new URL(req.url, 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  const pathMatches =
    parts.length === 2 &&
    parts[0] === 'hook' &&
    timingSafeEqualStr(parts[1], config.webhook.pathSecret)
  if (!pathMatches) {
    res.writeHead(404).end()
    return
  }

  // Some providers validate the endpoint with a bodyless HEAD/GET when you
  // register it. The path secret already gated us here; ack and stop.
  if (req.method === 'HEAD' || req.method === 'GET') {
    res.writeHead(200).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(404).end()
    return
  }

  const raw = await readRawBody(req)
  if (!verifySignature(raw, req.headers[config.webhook.signatureHeader])) {
    console.warn(`[webhook] signature rejected (${raw.length}B body, sig hdr ${req.headers[config.webhook.signatureHeader] ? 'present' : 'absent'}) — check WEBHOOK_SECRET / signature settings`)
    res.writeHead(401).end()
    return
  }

  // Authenticated. Always 200 so the sender doesn't retry; the run happens
  // after the ack since agent runs take far longer than any webhook timeout.
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))

  console.log('[webhook] verified delivery — starting run')
  runWebhook(raw)
}

export async function startWebhook() {
  const c = config.webhook
  if (!c.enabled) return null
  if (!c.signingSecret || !c.pathSecret) {
    throw new Error('ENABLE_WEBHOOK=true requires WEBHOOK_SECRET and WEBHOOK_PATH_SECRET')
  }
  if (!c.profile) {
    throw new Error('ENABLE_WEBHOOK=true requires WEBHOOK_PROFILE (the profile triggered runs use)')
  }
  if (!Number.isInteger(c.port) || c.port <= 0) {
    throw new Error(`Invalid WEBHOOK_PORT: ${c.port}`)
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = Number.isInteger(err.status) ? err.status : 500
      if (status >= 500) console.error('[webhook]', err)
      if (!res.headersSent) res.writeHead(status).end()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    // Bind localhost only. Public reach is the operator's reverse proxy /
    // tunnel to arrange, never a wide bind here.
    server.listen(c.port, '127.0.0.1', resolve)
  })
  console.log(`[webhook] listener on http://127.0.0.1:${c.port} (path /hook/<secret>, profile /${c.profile})`)
  return server
}
