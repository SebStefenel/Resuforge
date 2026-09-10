// One entry point for every AI call in the app: `ask(settings, prompt, opts)`.
//
// Two providers, in a fixed preference order. Gemini is tried first and kept as
// long as it keeps answering — that's the free tier, so it should absorb as much
// of the work as it can. GLM (a paid monthly plan) is only reached once Gemini
// won't serve: quota spent, key rejected, or repeated transport failures.
//
// Transport differs per provider, and not by choice:
//
//   Gemini — called straight from the browser. generativelanguage.googleapis.com
//            answers a CORS preflight with access-control-allow-origin, so the
//            page can talk to it with no backend in the path.
//   GLM    — proxied through the compile backend's POST /api/ai. api.z.ai
//            answers a preflight with no allow-origin header at all, so a
//            browser blocks a direct call no matter what headers we set.
//
// Nothing here is stateful except the cooldown bookkeeping below, which is
// deliberately module-level: once Gemini has said "out of quota", every
// subsequent call in this tab should skip straight to GLM instead of spending a
// round trip rediscovering it.
import { authFetch } from './api'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------
// 'quota'     — rate//usage limit hit. Expected, and the whole reason GLM exists.
// 'auth'      — key missing, malformed or rejected. Not retryable; fall through
//               to the other provider, but say so loudly: it's usually a typo.
// 'transient' — 5xx or a network blip. Retry the same provider, then fall through.
// 'request'   — we built a bad request. Do NOT fall through; the other provider
//               would fail the same way and the real bug would stay hidden.
export class AiError extends Error {
  constructor(kind, message, { provider, status, body } = {}) {
    super(message)
    this.name = 'AiError'
    this.kind = kind
    this.provider = provider
    this.status = status
    this.body = body
  }
}

function classify(status, bodyText) {
  if (status === 429) return 'quota'
  if (status === 401 || status === 403) {
    // Google uses 403 for both "key invalid" and some quota conditions.
    return /quota|exhaust|rate limit|billing/i.test(bodyText || '') ? 'quota' : 'auth'
  }
  if (status === 400) {
    // An expired or malformed key comes back as 400 INVALID_ARGUMENT from Gemini.
    return /api[ _-]?key|unauthenticat|credential/i.test(bodyText || '') ? 'auth' : 'request'
  }
  if (status >= 500) return 'transient'
  return 'request'
}

// ---------------------------------------------------------------------------
// Gemini cooldown
// ---------------------------------------------------------------------------
// A 429 can mean "too fast, wait 30 seconds" (per-minute limit) or "come back
// tomorrow" (per-day limit). Gemini distinguishes them in the error payload, so
// read it — conflating them is costly in both directions:
//
//   'rate'  — requests per minute. This is NOT running out of Gemini, it's going
//             too fast. The right response is to wait a few seconds and carry on
//             with Gemini; spending the paid GLM plan over a momentary 429 is
//             exactly what the preference order exists to avoid.
//   'daily' — requests per day spent. That IS running out, and is what GLM is
//             for.
const MINUTE_COOLDOWN_MS = 60 * 1000
const DAY_COOLDOWN_MS = 60 * 60 * 1000 // re-probe hourly rather than sleeping till midnight
// Longest we'll sit waiting for a per-minute limit before deciding it isn't
// worth holding the run up and handing the call to GLM instead.
const MAX_RATE_WAIT_MS = 90 * 1000

let geminiBlockedUntil = 0
let geminiBlockedKind = null // 'rate' | 'daily'

export function geminiCooldown() {
  const left = geminiBlockedUntil - Date.now()
  return left > 0
    ? { msLeft: left, kind: geminiBlockedKind, reason: geminiBlockedKind === 'daily' ? 'daily quota spent' : 'rate limited' }
    : null
}

export function clearGeminiCooldown() {
  geminiBlockedUntil = 0
  geminiBlockedKind = null
}

function blockGemini(ms, kind) {
  const until = Date.now() + ms
  // A daily block always wins over a rate block: it's the more severe state and
  // must not be shortened by a later per-minute 429.
  if (kind === 'daily' || until > geminiBlockedUntil) {
    geminiBlockedUntil = kind === 'daily' ? Math.max(geminiBlockedUntil, until) : until
    geminiBlockedKind = geminiBlockedKind === 'daily' ? 'daily' : kind
  }
}

/** Pull `retryDelay: "35s"` and the quota id out of a Gemini error body. */
function geminiQuotaHint(body) {
  let retryMs = null
  let perDay = false
  try {
    const details = body?.error?.details || []
    for (const d of details) {
      const t = String(d['@type'] || '')
      if (t.endsWith('RetryInfo') && typeof d.retryDelay === 'string') {
        const m = /^([\d.]+)s$/.exec(d.retryDelay)
        if (m) retryMs = Math.ceil(parseFloat(m[1]) * 1000)
      }
      if (t.endsWith('QuotaFailure')) {
        for (const v of d.violations || []) {
          if (/PerDay/i.test(`${v.quotaId || ''}${v.quotaMetric || ''}`)) perDay = true
        }
      }
    }
  } catch {}
  return { retryMs, perDay }
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------
async function callGemini(settings, prompt, { json, temperature, signal }) {
  const key = (settings.geminiKey || '').trim()
  if (!key) throw new AiError('auth', 'No Gemini API key set', { provider: 'gemini' })

  const model = (settings.geminiModel || 'gemini-2.5-flash').trim()
  const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        ...(temperature == null ? {} : { temperature }),
        // Asking for JSON at the API level is far more reliable than asking for
        // it in the prompt and hoping for no prose around it.
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
    signal,
  })

  const raw = await res.text()
  if (!res.ok) {
    let body = null
    try { body = JSON.parse(raw) } catch {}
    const kind = classify(res.status, raw)
    if (kind === 'quota') {
      const { retryMs, perDay } = geminiQuotaHint(body)
      // retryDelay is a pacing hint for a per-minute limit; it must not shorten a
      // daily exhaustion into a 30-second nap.
      blockGemini(perDay ? DAY_COOLDOWN_MS : (retryMs ?? MINUTE_COOLDOWN_MS),
                  perDay ? 'daily' : 'rate')
    }
    throw new AiError(kind, body?.error?.message || `Gemini HTTP ${res.status}`,
                      { provider: 'gemini', status: res.status, body: raw.slice(0, 1500) })
  }

  const body = JSON.parse(raw)
  const cand = body?.candidates?.[0]
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('')
  if (!text) {
    // A MAX_TOKENS or SAFETY stop is a real outcome, not a transport failure —
    // name it so a truncated batch doesn't look like a parse bug.
    throw new AiError('request', `Gemini returned no text (finishReason: ${cand?.finishReason || 'unknown'})`,
                      { provider: 'gemini', body: raw.slice(0, 1500) })
  }
  return { text, provider: 'gemini', model, usage: body?.usageMetadata ?? null }
}

// Which wire protocol the configured endpoint speaks, read off the URL rather
// than stored as a separate setting — the path already says which API it is, and
// one fewer field is one fewer thing to get out of step with the other.
//
// This matters because a Coding Plan key is only entitled on the Anthropic route:
// pointed at /paas/v4 it comes back 429 "Insufficient balance or no resource
// package", which looks like a dead key but is the wrong endpoint.
export const glmProtocol = (baseUrl) =>
  /\/anthropic(\/|$)/.test(String(baseUrl || '')) ? 'anthropic' : 'openai'

async function callGlm(settings, prompt, { json, temperature, signal }) {
  const key = (settings.glmKey || '').trim()
  if (!key) throw new AiError('auth', 'No GLM API key set', { provider: 'glm' })

  const model = (settings.glmModel || 'glm-4.6').trim()
  const baseUrl = (settings.glmBaseUrl || 'https://api.z.ai/api/anthropic').trim()
  const res = await authFetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      protocol: glmProtocol(baseUrl),
      model,
      apiKey: key,
      jsonMode: !!json,
      temperature,
      // Enough for a full batch of compensation rows plus the short thinking
      // block the model emits even when thinking is disabled.
      maxTokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  })

  const raw = await res.text()
  if (!res.ok) {
    let body = null
    try { body = JSON.parse(raw) } catch {}
    // The proxy passes the provider's status through, so classify on that when
    // present; otherwise this was our own backend failing.
    const status = body?.providerStatus ?? res.status
    throw new AiError(classify(status, body?.body || raw), body?.error || `GLM HTTP ${status}`,
                      { provider: 'glm', status, body: (body?.body || raw || '').slice(0, 1500) })
  }

  const body = JSON.parse(raw)
  if (!body.text) {
    throw new AiError('request', `GLM returned no text (finishReason: ${body.finishReason || 'unknown'})`,
                      { provider: 'glm', body: raw.slice(0, 1500) })
  }
  return { text: body.text, provider: 'glm', model, usage: body.usage ?? null }
}

// ---------------------------------------------------------------------------
// the public call
// ---------------------------------------------------------------------------
export const hasAnyKey = (s) => !!(s && ((s.geminiKey || '').trim() || (s.glmKey || '').trim()))

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) },
                           { once: true })
})

/**
 * Ask whichever provider can answer.
 *
 * Resolves { text, provider, model, usage, fellBack, notes } — `provider` is
 * which one actually answered, and `notes` carries why Gemini was skipped or
 * refused, so the UI can tell the user their key is wrong instead of silently
 * spending the paid plan.
 *
 * `onNote` is called with the same messages as they happen, for live progress.
 */
export async function ask(settings, prompt, opts = {}) {
  const { json = false, temperature = 0, signal, retries = 2, onNote } = opts
  const notes = []
  const note = (m) => { notes.push(m); onNote?.(m) }

  const hasGemini = !!(settings.geminiKey || '').trim()
  const hasGlm = !!(settings.glmKey || '').trim()
  if (!hasGemini && !hasGlm) throw new AiError('auth', 'No AI provider is configured')

  // Decide who goes first, and whether it's worth waiting for Gemini.
  //
  // A per-minute limit is not "out of Gemini": wait it out and stay on the free
  // tier, which is what the user asked for. Only a spent daily quota — or no
  // Gemini key at all — should reach for the paid plan. If there is no GLM key,
  // waiting is the only option regardless of which kind it is.
  let cooling = hasGemini ? geminiCooldown() : null
  if (cooling) {
    const waitable = cooling.kind === 'rate' && cooling.msLeft <= MAX_RATE_WAIT_MS
    if (waitable || !hasGlm) {
      const waitMs = Math.min(cooling.msLeft, hasGlm ? MAX_RATE_WAIT_MS : MINUTE_COOLDOWN_MS)
      note(`Gemini ${cooling.reason}; waiting ${Math.ceil(waitMs / 1000)}s rather than using GLM`)
      await sleep(waitMs, signal)
      clearGeminiCooldown()
      cooling = null
    }
  }

  const order = []
  if (hasGemini && !cooling) order.push('gemini')
  if (hasGlm) order.push('glm')
  // Gemini is still walled and GLM isn't configured: try anyway so the caller
  // gets the provider's own error rather than a silent nothing.
  if (order.length === 0) order.push('gemini')

  if (cooling && order[0] === 'glm') note(`Gemini ${cooling.reason} — falling back to GLM`)

  let lastErr = null
  for (const provider of order) {
    const call = provider === 'gemini' ? callGemini : callGlm
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const out = await call(settings, prompt, { json, temperature, signal })
        return { ...out, fellBack: provider !== 'gemini', notes }
      } catch (err) {
        if (err?.name === 'AbortError') throw err
        lastErr = err
        const kind = err instanceof AiError ? err.kind : 'transient'

        // Our own malformed request: trying again, or trying elsewhere, just
        // hides it.
        if (kind === 'request') throw err

        if (kind === 'transient' && attempt < retries) {
          await sleep(500 * 2 ** attempt, signal)
          continue
        }

        // A per-minute limit hit mid-call. Without this the very first 429 of a
        // run would hand the batch to the paid plan even though Gemini is fine
        // in a few seconds — the cooldown check at the top of ask() only helps
        // the calls that come after. Wait here and stay on the free tier.
        if (kind === 'quota' && provider === 'gemini' && attempt < retries) {
          const cd = geminiCooldown()
          if (cd && cd.kind === 'rate' && cd.msLeft <= MAX_RATE_WAIT_MS) {
            note(`Gemini rate limited; waiting ${Math.ceil(cd.msLeft / 1000)}s rather than using GLM`)
            await sleep(cd.msLeft, signal)
            clearGeminiCooldown()
            continue
          }
        }
        note(`${provider} failed (${kind}): ${err.message}`)
        break // next provider
      }
    }
  }
  throw lastErr ?? new AiError('transient', 'Every provider failed')
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSON out of a model response. Even with a JSON mime type asked for,
 * models sometimes wrap output in a ```json fence or prepend a sentence, and one
 * stray character shouldn't discard a whole batch.
 */
export function parseJsonLoose(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {}
  // Fall back to the outermost array or object in the string.
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const a = cleaned.indexOf(open)
    const b = cleaned.lastIndexOf(close)
    if (a !== -1 && b > a) {
      try { return JSON.parse(cleaned.slice(a, b + 1)) } catch {}
    }
  }
  throw new Error(`Model did not return usable JSON: ${cleaned.slice(0, 200)}`)
}

/** Smallest possible live check that a key works, for the settings panel. */
export async function testProvider(settings, provider, { signal } = {}) {
  const one = provider === 'gemini'
    ? { ...settings, glmKey: '' }
    : { ...settings, geminiKey: '' }
  // Bypass a cooldown from an earlier run: the point of a test is to find out
  // the current state.
  if (provider === 'gemini') clearGeminiCooldown()
  const started = Date.now()
  const out = await ask(one, 'Reply with the single word: ok', { retries: 0, signal })
  return { ok: true, provider: out.provider, model: out.model, ms: Date.now() - started, text: out.text.trim().slice(0, 40) }
}
