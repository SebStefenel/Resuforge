// Turns a posting's free-text "Compensation and Benefits" blurb into one
// comparable number: the equivalent hourly wage in CAD.
//
// The text is written by whoever posted the job, so it arrives as anything at
// all — "$25.50/hour", "80,000 CAD per annum", "USD 7,500/month", "competitive
// salary and great culture", a table of benefits with no figure in it. A parser
// would be a losing battle, which is why this asks a model. What the model is
// NOT trusted with is arithmetic constants: the USD→CAD rate and the hours in a
// work week are pinned in the prompt from the user's settings, so two postings
// converted a week apart are comparable, and a number that looks wrong is a
// setting to correct rather than a hallucination to chase.
import { ask, parseJsonLoose } from './ai'

// Postings per request. Small enough that one malformed response costs little
// and the output can't run into a token ceiling; large enough that 572 postings
// is ~50 calls rather than 572.
export const BATCH_SIZE = 12
// A compensation blurb can run to a page of benefits boilerplate; the figure is
// essentially always near the top.
const MAX_CHARS = 1200

const money = (n) => (Math.round(n * 100) / 100).toFixed(2)

/** The display string the posting shows: "25.00", "25.00–30.00", or "NA". */
export function formatHourly(min, max) {
  if (min == null && max == null) return 'NA'
  if (min != null && max != null && Math.abs(max - min) >= 0.01) return `${money(min)}–${money(max)}`
  return money(min ?? max)
}

function buildPrompt(items, { usdCad, hoursPerWeek }) {
  return `You convert job-posting compensation text into an equivalent hourly wage in Canadian dollars.

Use exactly these constants. Do not substitute your own:
- 1 USD = ${usdCad} CAD
- a full-time work week is ${hoursPerWeek} hours
- a work year is ${hoursPerWeek} * 52 = ${hoursPerWeek * 52} hours

Rules:
1. Find the cash compensation rate for the student doing this job. Convert it to CAD per hour.
   - hourly -> use as is
   - weekly -> divide by ${hoursPerWeek}
   - bi-weekly -> divide by ${hoursPerWeek * 2}
   - monthly -> multiply by 12, divide by ${hoursPerWeek * 52}
   - annual/salary -> divide by ${hoursPerWeek * 52}
2. If the amount is a range, report both ends. If it is a single figure, report it as both min and max.
3. Currency: if the text says USD or US$, convert with the rate above. If it says CAD, C$, or names no
   currency at all, treat it as CAD. If it is any OTHER currency, return null for both numbers and put
   the currency code in "note" — do not invent an exchange rate.
4. Return null for both numbers when there is no specific figure to convert. This includes
   "competitive", "to be determined", "based on experience", unpaid, or text that only lists benefits,
   bonuses, perks, transit passes, housing, gym memberships or overtime policy with no base rate.
5. A signing bonus, relocation allowance or housing stipend is NOT the wage. Ignore it unless it is the
   only cash figure AND it is clearly expressed as a rate of pay.
6. Never guess or estimate a market rate. Only convert figures that are actually in the text.

Return a JSON array with one object per input id, in the same order, and nothing else:
[{"id":"<id>","min":<number|null>,"max":<number|null>,"basis":"hourly"|"weekly"|"biweekly"|"monthly"|"annual"|null,"currency":"<code as stated, or null>","note":"<max 12 words, why, or which currency blocked it>"}]

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
  // A negative or absurd hourly rate means the model mis-read the text; drop it
  // rather than showing a number nobody should act on.
  return Number.isFinite(n) && n > 0 && n < 10000 ? n : null
}

const BASES = new Set(['hourly', 'weekly', 'biweekly', 'monthly', 'annual'])

/**
 * Normalize one batch. Returns a Map of id -> field value, containing only the
 * ids the model actually answered for — a caller must not assume completeness.
 */
export async function normalizeBatch(settings, items, opts = {}) {
  const out = new Map()
  if (items.length === 0) return out

  const res = await ask(settings, buildPrompt(items, settings), {
    json: true,
    temperature: 0,
    signal: opts.signal,
    onNote: opts.onNote,
  })

  const rows = parseJsonLoose(res.text)
  if (!Array.isArray(rows)) throw new Error('Model did not return a JSON array')

  const wanted = new Map(items.map((p) => [String(p.id), p]))
  const at = new Date().toISOString()

  for (const row of rows) {
    const id = String(row?.id ?? '')
    if (!wanted.has(id)) continue // hallucinated id, or one from another batch

    let min = num(row.min)
    let max = num(row.max)
    // A one-sided range is a range with a missing end, not a point value.
    if (min == null && max != null) min = max
    if (max == null && min != null) max = min
    if (min != null && max != null && min > max) [min, max] = [max, min]

    out.set(id, {
      text: formatHourly(min, max),
      min,
      max,
      basis: BASES.has(row.basis) ? row.basis : null,
      currency: typeof row.currency === 'string' && row.currency.trim()
        ? row.currency.trim().toUpperCase().slice(0, 8)
        : null,
      note: typeof row.note === 'string' ? row.note.trim().slice(0, 120) : '',
      provider: res.provider,
      model: res.model,
      at,
    })
  }
  return out
}

/**
 * Normalize a whole dataset, in batches, reporting progress as it goes.
 *
 * Resumable by construction: postings that already carry an `hourlyCad` are
 * skipped, so re-running after a cancel, a failure or a fresh import only does
 * the outstanding work. `onProgress` receives the updated postings array at each
 * checkpoint so the caller can persist partial results — a run over 572 postings
 * takes minutes and must not be all-or-nothing.
 */
export async function normalizeAll(settings, postings, opts = {}) {
  const { signal, onProgress, onNote, pacingMs = 1200, force = false } = opts

  const todo = postings.filter((p) => force || (!p.hourlyCad && p.compensation))
  // No compensation text at all is a definite NA; it needs no model call.
  const blank = postings.filter((p) => !p.hourlyCad && !p.compensation)

  const results = new Map()
  const at = new Date().toISOString()
  for (const p of blank) {
    results.set(String(p.id), {
      text: 'NA', min: null, max: null, basis: null, currency: null,
      note: 'no compensation text in the posting', provider: null, model: null, at,
    })
  }

  const stats = { total: todo.length, done: 0, failed: 0, batches: 0, byProvider: {}, errors: [] }
  const apply = () => postings.map((p) => {
    const v = results.get(String(p.id))
    return v ? { ...p, hourlyCad: v } : p
  })

  if (blank.length) onProgress?.(apply(), stats)

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    if (signal?.aborted) break
    const batch = todo.slice(i, i + BATCH_SIZE)
    stats.batches++

    try {
      const got = await normalizeBatch(settings, batch, { signal, onNote })
      for (const [id, v] of got) {
        results.set(id, v)
        stats.byProvider[v.provider] = (stats.byProvider[v.provider] || 0) + 1
      }
      stats.done += got.size
      // An id the model skipped is a failure for this batch, not a silent pass.
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
