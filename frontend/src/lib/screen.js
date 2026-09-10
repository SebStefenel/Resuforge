// Screening a batch of postings against a subjective question, in two passes.
//
// Pass 1 asks the model which FIELDS a question needs. Pass 2 sends only those
// fields for every posting and asks keep/drop.
//
// The split exists to stop paying for text that cannot affect the answer. A
// posting carries a summary, responsibilities, skills, compensation text, a
// normalized wage, location, disciplines, deadlines and more; sending all of it
// for "does this involve building ML infrastructure?" spends most of the tokens
// on compensation and logistics that no honest answer would consult. Pass 1
// costs one request for the whole run and typically removes three quarters of
// the payload from the several dozen requests that follow.
//
// Pass 1 is also a place the model can be wrong cheaply — the chosen fields are
// shown to the user before pass 2 runs, and can be corrected.
import { ask, parseJsonLoose } from './ai'

// What a question may ask to see, and how each is rendered for the model.
// Anything not listed here can never reach a screening prompt.
export const SCREEN_FIELDS = {
  title:          { label: 'Title', describe: 'the job title', get: (p) => p.title },
  organization:   { label: 'Employer', describe: 'the employer name', get: (p) => p.organization },
  division:       { label: 'Division', describe: 'the team or division within the employer', get: (p) => p.division },
  jobType:        { label: 'Job type', describe: 'the job type', get: (p) => p.jobType },
  summary:        { label: 'Summary', describe: 'the job summary — what the role is about', get: (p) => p.summary },
  responsibilities:{ label: 'Responsibilities', describe: 'the day-to-day responsibilities', get: (p) => p.responsibilities },
  skills:         { label: 'Skills', describe: 'required skills, technologies and qualifications', get: (p) => p.skills },
  compensation:   { label: 'Compensation text', describe: 'the raw compensation and benefits text', get: (p) => p.compensation },
  hourlyCad:      { label: 'Pay (CAD/hr)', describe: 'the normalized wage in CAD per hour', get: (p) => p.hourlyCad?.text },
  location:       { label: 'Location', describe: 'city, province, country, and remote/hybrid/in-person', get: (p) =>
                      [p.location?.city, p.location?.province, p.location?.country, p.location?.arrangement].filter(Boolean).join(', ') },
  levels:         { label: 'Level', describe: 'junior / intermediate / senior', get: (p) => p.levels?.join(', ') },
  clusters:       { label: 'Disciplines', describe: 'the degrees and disciplines the posting targets', get: (p) => p.clusters?.join('; ') },
  duration:       { label: 'Duration', describe: 'the work term length', get: (p) => p.duration?.raw },
  workTerm:       { label: 'Work term', describe: 'which term the job runs in, e.g. 2027 - Winter', get: (p) => p.workTerm?.raw },
  openings:       { label: 'Openings', describe: 'how many openings there are', get: (p) => p.openings },
  applicants:     { label: 'Applicants', describe: 'how many people have applied so far', get: (p) => p.applicants },
  deadline:       { label: 'Deadline', describe: 'the application deadline', get: (p) => p.deadline?.date },
  specialRequirements: { label: 'Special requirements', describe: 'special job requirements such as licences or clearances', get: (p) => p.specialRequirements },
  transportationHousing: { label: 'Transport/housing', describe: 'transportation and housing notes', get: (p) => p.transportationHousing },
  documents:      { label: 'Documents', describe: 'which application documents are required', get: (p) => p.application?.documents?.join(', ') },
}

export const FIELD_KEYS = Object.keys(SCREEN_FIELDS)

// Title always rides along: it costs almost nothing and makes every judgment
// legible to a human reading the reasons afterwards.
const ALWAYS = ['title']

// Long prose fields get clipped. The opening lines of a summary carry the
// substance; the tail is usually equal-opportunity boilerplate.
const MAX_FIELD_CHARS = 700
// Target size of one screening request. Batch size is derived from this rather
// than fixed, because a question needing only `title` can take far more postings
// per call than one needing summary + responsibilities + skills.
const TARGET_CHARS = 11000
const MIN_BATCH = 3
const MAX_BATCH = 40

// ── pass 1: which fields does this question need? ────────────────────────────

export async function chooseFields(settings, question, opts = {}) {
  const menu = FIELD_KEYS.map((k) => `- ${k}: ${SCREEN_FIELDS[k].describe}`).join('\n')
  const prompt = `Someone is filtering co-op job postings with this requirement:

"""
${question}
"""

Each posting has these fields available:
${menu}

Which of those fields does a careful reader actually need in order to decide whether a posting meets that requirement?

Choose the FEWEST that suffice. Every field you include is sent for every posting, so including one that cannot change the answer is pure waste. Do not include a field just because it is related to the job — include it only if the requirement cannot be judged without it.

Return a JSON array of field names, and nothing else. For example: ["summary","skills"]`

  const res = await ask(settings, prompt, { json: true, temperature: 0, signal: opts.signal, onNote: opts.onNote })
  const raw = parseJsonLoose(res.text)
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.fields) ? raw.fields : []

  const chosen = list.map(String).filter((k) => Object.prototype.hasOwnProperty.call(SCREEN_FIELDS, k))
  // A model that answers with nothing usable shouldn't sink the run; fall back to
  // the fields that describe what a job actually is.
  const fields = chosen.length ? chosen : ['summary', 'responsibilities', 'skills']
  for (const k of ALWAYS) if (!fields.includes(k)) fields.unshift(k)

  return { fields: [...new Set(fields)], provider: res.provider, model: res.model }
}

// ── pass 2: judge each posting on those fields ───────────────────────────────

const clip = (v) => {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim()
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) + '…' : s
}

/** A posting reduced to just the fields a question needs. */
export function projectPosting(p, fields) {
  const out = { id: String(p.id) }
  for (const k of fields) {
    const spec = SCREEN_FIELDS[k]
    if (!spec) continue
    const v = clip(spec.get(p))
    if (v) out[k] = v
  }
  return out
}

/** How many projected postings fit comfortably in one request. */
export function batchSizeFor(projected) {
  if (!projected.length) return MIN_BATCH
  const sample = projected.slice(0, 24)
  const avg = sample.reduce((n, p) => n + JSON.stringify(p).length, 0) / sample.length
  return Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.floor(TARGET_CHARS / Math.max(avg, 80))))
}

function judgePrompt(question, items) {
  return `Decide, for each job posting below, whether it satisfies this requirement:

"""
${question}
"""

Rules:
- Judge only on the information given. You are shown a deliberately limited set of fields.
- If what you are shown is not enough to tell, answer false. Do not guess, and do not assume a
  posting qualifies because its employer or title sounds like it might.
- Be strict about the requirement as written rather than generous about what is close to it.

Return a JSON array with one object per posting id, in the same order, and nothing else:
[{"id":"<id>","keep":true|false,"reason":"<at most 15 words>"}]

Postings:
${JSON.stringify(items, null, 1)}`
}

/**
 * Screen every posting. Resolves { kept, judgments, stats }.
 *
 * `judgments` is { [id]: { keep, reason } } for everything judged, kept or not,
 * so a batch can show why each posting is in it and why the others aren't.
 *
 * A batch that fails outright leaves its postings unjudged rather than silently
 * dropping them — an unanswered posting must never look like a rejected one.
 */
export async function screenPostings(settings, postings, question, fields, opts = {}) {
  const { signal, onProgress, onNote, pacingMs = 1000 } = opts

  const projected = postings.map((p) => projectPosting(p, fields))
  const size = batchSizeFor(projected)
  const stats = { total: postings.length, judged: 0, kept: 0, failed: 0, batches: 0, byProvider: {}, errors: [] }
  const judgments = {}

  for (let i = 0; i < projected.length; i += size) {
    if (signal?.aborted) break
    const slice = projected.slice(i, i + size)
    stats.batches++

    try {
      const res = await ask(settings, judgePrompt(question, slice), {
        json: true, temperature: 0, signal, onNote,
      })
      const rows = parseJsonLoose(res.text)
      if (!Array.isArray(rows)) throw new Error('Model did not return a JSON array')

      const wanted = new Set(slice.map((p) => p.id))
      let answered = 0
      for (const row of rows) {
        const id = String(row?.id ?? '')
        if (!wanted.has(id) || judgments[id]) continue
        const keep = row.keep === true || row.keep === 'true'
        judgments[id] = { keep, reason: typeof row.reason === 'string' ? row.reason.trim().slice(0, 140) : '' }
        answered++
        if (keep) stats.kept++
      }
      stats.judged += answered
      stats.byProvider[res.provider] = (stats.byProvider[res.provider] || 0) + 1
      const missed = slice.length - answered
      if (missed > 0) {
        stats.failed += missed
        stats.errors.push(`${missed} of ${slice.length} postings went unanswered in one batch`)
      }
    } catch (err) {
      if (err?.name === 'AbortError') break
      stats.failed += slice.length
      stats.errors.push(err.message || String(err))
      onNote?.(`batch failed: ${err.message || err}`)
    }

    onProgress?.({ ...stats })
    if (pacingMs && i + size < projected.length && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, pacingMs))
    }
  }

  const kept = postings.filter((p) => judgments[String(p.id)]?.keep)
  return { kept, judgments, stats, batchSize: size }
}

/** Rough token saving from pass 1, for showing the user what it bought. */
export function projectionSaving(postings, fields) {
  const all = FIELD_KEYS
  const sample = postings.slice(0, 40)
  if (!sample.length) return null
  const size = (ks) => sample.reduce((n, p) => n + JSON.stringify(projectPosting(p, ks)).length, 0)
  const full = size(all)
  const trimmed = size(fields)
  if (!full) return null
  return { full, trimmed, percent: Math.round((1 - trimmed / full) * 100) }
}
