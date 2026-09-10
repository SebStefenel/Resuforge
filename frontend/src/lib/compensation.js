// Turns a posting's free-text "Compensation and Benefits" blurb into one
// comparable number: the equivalent hourly wage in CAD.
//
// The text is written by whoever posted the job, so it arrives as anything at
// all — "$25.50/hour", "80,000 CAD per annum", "USD 7,500/month", "competitive
// salary and great culture", a page of benefits with no figure in it. A parser
// would be a losing battle, which is why a model reads it.
//
// But the model only ever EXTRACTS. It reports the figure and the unit it found;
// this file does the conversion. That division is deliberate and was learned the
// hard way: asked to convert, the model returned 4,620/hr for a posting paying
// $7,000-9,000 USD per month (83x too high), 662/hr for one paying $10,000-12,500
// USD per month (8.4x), and quietly used 1.38 as the exchange rate on everything
// else when the prompt pinned 1.37. Extraction it does well; arithmetic belongs
// in code, where it is exact, auditable, and identical every run.
import { ask, parseJsonLoose } from './ai'

// Postings per request. Small enough that one malformed response costs little
// and the output can't run into a token ceiling; large enough that 572 postings
// is ~50 calls rather than 572.
export const BATCH_SIZE = 12
// A compensation blurb can run to a page of benefits boilerplate; the figure is
// essentially always near the top.
const MAX_CHARS = 1200

// Hours in each pay period, derived from the user's hours-per-week setting.
const periodHours = (hpw) => ({
  hourly: 1,
  weekly: hpw,
  biweekly: hpw * 2,
  monthly: (hpw * 52) / 12,
  annual: hpw * 52,
})

// A student co-op wage outside this band in CAD/hour is a units error, not a
// salary — a real one sits somewhere around 15-140. The band is wide on purpose:
// it exists to catch a figure that skipped a conversion, not to second-guess a
// number the posting genuinely states.
const MIN_HOURLY = 2
const MAX_HOURLY = 400

const money = (n) => (Math.round(n * 100) / 100).toFixed(2)

/**
 * The value shown for a posting. When a posting quotes a range, this is the
 * BOTTOM of it: the figure you can actually count on being offered. The top is
 * kept on the record and shown in the detail panel.
 */
export function formatHourly(min) {
  return min == null ? 'NA' : money(min)
}

/** "55.33-71.13" for the detail panel, where the full range is worth seeing. */
export function formatRange(min, max) {
  if (min == null) return 'NA'
  return max != null && Math.abs(max - min) >= 0.01 ? `${money(min)}–${money(max)}` : money(min)
}

// A compensation blurb with no digit anywhere in it cannot contain a rate of
// pay, so it is NA by inspection — no model call, no chance of invention.
export const hasFigure = (text) => /\d/.test(String(text || ''))

function buildPrompt(items) {
  return `You extract stated pay rates from job-posting compensation text. You do NOT convert, calculate or estimate — report the numbers exactly as the text gives them.

For each input, find the cash rate of pay for the student doing the job:
- "amount_min" / "amount_max": the figures as written, digits only (strip $ and commas). If the text
  gives one figure rather than a range, put the same number in both.
- "period": the unit the amount is quoted in — "hourly", "weekly", "biweekly", "monthly" or "annual".
- "currency": the currency code ONLY if the text actually states one ("USD", "US$", "CAD", "EUR", ...).
  If the text names no currency at all, return null. Do not infer one from the employer or location.
- "note": at most 12 words saying where the figure came from.

Report nulls for amount_min, amount_max and period when there is no rate of pay in the text. That
includes "competitive", "to be determined", "based on experience", unpaid roles, and text that only
lists benefits, perks, transit passes, gym memberships, meals, insurance or overtime policy.

A signing bonus, relocation allowance, equity grant or housing stipend is NOT the wage. Ignore it
unless it is the only cash figure AND it is clearly a rate of pay.

If several rates are given for different terms or levels, report the lowest as amount_min and the
highest as amount_max.

Never estimate a market rate. Only report figures that literally appear in the text.

Return a JSON array with one object per input id, in the same order, and nothing else:
[{"id":"<id>","amount_min":<number|null>,"amount_max":<number|null>,"period":"hourly"|"weekly"|"biweekly"|"monthly"|"annual"|null,"currency":"<code>","note":"<short>"}]

Input:
${JSON.stringify(
  items.map((p) => ({ id: p.id, compensation: (p.compensation || '').slice(0, MAX_CHARS) })),
  null,
  1
)}`
}

const num = (v) => {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

const PERIODS = new Set(['hourly', 'weekly', 'biweekly', 'monthly', 'annual'])

// Markers that a currency is genuinely named in the text.
const CURRENCY_MARKERS = {
  USD: /\bUSD\b|\bUS\s?\$|\bU\.S\.\s*dollar/i,
  CAD: /\bCAD\b|\bC\$|\bcanadian\s+dollar/i,
}

/**
 * Decide which currency a figure is actually in, rather than taking the model's
 * word for it.
 *
 * A posting reading "$45,074 / month" names no currency, and the model reported
 * it as USD anyway — which turned a correct 260.04 CAD/hr into 356.26. The
 * instruction to default to CAD was in the prompt and simply wasn't followed, so
 * the check belongs here where it is deterministic: a non-CAD currency is only
 * accepted if its marker really appears in the text.
 *
 * Returns { currency, corrected } — `corrected` is true when the model's claim
 * was overruled, which is worth surfacing in the note.
 */
export function verifyCurrency(claimed, text) {
  const cur = (claimed || '').toUpperCase()
  if (!cur || cur === 'CAD') return { currency: 'CAD', corrected: false }
  const marker = CURRENCY_MARKERS[cur] || new RegExp(`\\b${cur.replace(/[^A-Z]/g, '')}\\b`, 'i')
  if (marker.test(String(text || ''))) return { currency: cur, corrected: false }
  // Claimed a currency the text never mentions: fall back to the default rather
  // than applying an exchange rate to a number that was probably already CAD.
  return { currency: 'CAD', corrected: true }
}

const NA = (note, extra = {}) => ({
  text: 'NA', min: null, max: null, basis: null, currency: null, source: null, note, ...extra,
})

/**
 * Convert one extracted figure to CAD/hour. Pure, exact, and the only place
 * arithmetic happens. Returns { min, max } or null with a reason.
 */
export function toHourlyCad({ amountMin, amountMax, period, currency }, { usdCad, hoursPerWeek }) {
  if (amountMin == null || !PERIODS.has(period)) return { error: 'no rate of pay stated' }

  const cur = (currency || 'CAD').toUpperCase()
  // Only rates we were actually given are applied; anything else would be an
  // invented exchange rate wearing a number's clothes.
  const fx = cur === 'CAD' ? 1 : cur === 'USD' ? Number(usdCad) : null
  if (!fx) return { error: `${cur} — no exchange rate configured` }

  const hours = periodHours(Number(hoursPerWeek) || 40)[period]
  let min = (amountMin / hours) * fx
  let max = ((amountMax ?? amountMin) / hours) * fx
  if (min > max) [min, max] = [max, min]

  if (min < MIN_HOURLY || min > MAX_HOURLY) {
    return { error: `${money(min)}/hr is outside the plausible range — check the posting` }
  }
  // The top of the range is reported as computed. Clamping it to the band would
  // put a number on screen that no posting ever stated.
  return { min, max }
}

/**
 * Normalize one batch. Returns a Map of id -> field value, containing only the
 * ids the model actually answered for — a caller must not assume completeness.
 */
export async function normalizeBatch(settings, items, opts = {}) {
  const out = new Map()
  if (items.length === 0) return out

  const res = await ask(settings, buildPrompt(items), {
    json: true,
    temperature: 0,
    signal: opts.signal,
    onNote: opts.onNote,
  })

  const rows = parseJsonLoose(res.text)
  if (!Array.isArray(rows)) throw new Error('Model did not return a JSON array')

  const wanted = new Set(items.map((p) => String(p.id)))
  const at = new Date().toISOString()
  const stamp = { provider: res.provider, model: res.model, at }

  for (const row of rows) {
    const id = String(row?.id ?? '')
    if (!wanted.has(id)) continue // hallucinated id, or one from another batch

    const amountMin = num(row.amount_min)
    const amountMax = num(row.amount_max)
    const period = PERIODS.has(row.period) ? row.period : null
    const claimed = typeof row.currency === 'string' ? row.currency.trim().toUpperCase().slice(0, 8) : null
    const posting = items.find((p) => String(p.id) === id)
    const { currency, corrected } = verifyCurrency(claimed, posting && posting.compensation)
    let note = typeof row.note === 'string' ? row.note.trim().slice(0, 120) : ''
    if (corrected) note = `read as CAD — the posting never says ${claimed}${note ? '; ' + note : ''}`

    const conv = toHourlyCad({ amountMin, amountMax, period, currency }, settings)
    if (conv.error) {
      out.set(id, NA(conv.error, stamp))
      continue
    }
    out.set(id, {
      text: formatHourly(conv.min),
      min: conv.min,
      max: conv.max,
      basis: period,
      currency,
      // What the posting actually said, so any figure can be checked against
      // its source without reopening the posting.
      source: { min: amountMin, max: amountMax ?? amountMin, period, currency },
      note,
      ...stamp,
    })
  }
  return out
}

/**
 * Normalize a whole dataset, in batches, reporting progress as it goes.
 *
 * Resumable by construction: postings that already carry an `hourlyCad` are
 * skipped unless `force` is set, so re-running after a cancel, a failure or a
 * fresh import only does the outstanding work. `onProgress` receives the updated
 * postings array at each checkpoint so the caller can persist partial results —
 * a run over 572 postings takes minutes and must not be all-or-nothing.
 */
export async function normalizeAll(settings, postings, opts = {}) {
  const { signal, onProgress, onNote, pacingMs = 1200, force = false } = opts

  const outstanding = postings.filter((p) => force || !p.hourlyCad)
  // Settled without a model call: no digit in the text means no rate in the text.
  const noFigure = outstanding.filter((p) => !hasFigure(p.compensation))
  const todo = outstanding.filter((p) => hasFigure(p.compensation))

  const results = new Map()
  const at = new Date().toISOString()
  for (const p of noFigure) {
    results.set(String(p.id), NA(
      p.compensation ? 'no figure in the compensation text' : 'no compensation text in the posting',
      { provider: null, model: null, at }
    ))
  }

  const stats = { total: todo.length, done: 0, failed: 0, batches: 0, skipped: noFigure.length, byProvider: {}, errors: [] }
  const apply = () => postings.map((p) => {
    const v = results.get(String(p.id))
    return v ? { ...p, hourlyCad: v } : p
  })

  if (noFigure.length) onProgress?.(apply(), stats)

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    if (signal?.aborted) break
    const batch = todo.slice(i, i + BATCH_SIZE)
    stats.batches++

    try {
      const got = await normalizeBatch(settings, batch, { signal, onNote })
      for (const [id, v] of got) {
        results.set(id, v)
        if (v.provider) stats.byProvider[v.provider] = (stats.byProvider[v.provider] || 0) + 1
      }
      stats.done += got.size
      const missed = batch.length - got.size
      if (missed > 0) {
        stats.failed += missed
        stats.errors.push(`${missed} of ${batch.length} postings had no answer in one batch`)
      }
    } catch (err) {
      if (err?.name === 'AbortError') break
      stats.failed += batch.length
      stats.errors.push(err.message || String(err))
      onNote?.(`batch failed: ${err.message || err}`)
      // Keep going: one bad batch (a truncated response, a transient 5xx) should
      // not forfeit the other 500 postings.
    }

    onProgress?.(apply(), stats)
    if (pacingMs && i + BATCH_SIZE < todo.length && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, pacingMs))
    }
  }

  return { postings: apply(), stats }
}

/** How many postings still need a figure — drives the "run" affordance. */
export function pendingCount(postings) {
  return postings.filter((p) => !p.hourlyCad).length
}
