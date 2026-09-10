// Normalizes raw WaterlooWorks scrapes into a clean, typed dataset.
//
// This is the WW-Scraper `tools/clean.js` pipeline, moved into the browser so
// the whole flow — import, normalize, browse, export — happens on the page with
// no upload step. A finished scrape is several megabytes of JSON; parsing it
// here is instant, whereas round-tripping it through the compile backend would
// mean a multi-megabyte POST for no gain.
//
// Everything in this module is pure: give it parsed JSON documents, get back
// records, a report, and CSV text.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

const txt = (v) => (v == null ? null : String(v).trim() || null)

/** Bulleted values arrive as "• a\n\n• b"; tighten to one line per bullet. */
function tidy(v) {
  const s = txt(v)
  if (!s) return null
  return s
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}(?=\s*•)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim()
}

const asArray = (v) =>
  v == null ? [] : Array.isArray(v) ? v.map((x) => txt(x)).filter(Boolean) : [txt(v)].filter(Boolean)

function toInt(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

/** "Sep 17, 2026 9:00 AM" -> { raw, iso, date }. Times are local (Waterloo). */
function parseDeadline(raw) {
  const s = txt(raw)
  if (!s) return null
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i.exec(s)
  if (!m) return { raw: s, iso: null, date: null }
  const [, mon, day, year, hh, mm, ampm] = m
  const month = MONTHS[mon.toLowerCase()]
  if (month === undefined) return { raw: s, iso: null, date: null }
  let hour = hh ? parseInt(hh, 10) % 12 : 0
  if (ampm && /pm/i.test(ampm)) hour += 12
  const dt = new Date(+year, month, +day, hour, mm ? +mm : 0)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    raw: s,
    iso: dt.toISOString(),
    date: `${year}-${pad(month + 1)}-${pad(+day)}`,
  }
}

/** "8 month consecutive work term required" -> months/terms/consecutive/requirement */
function parseDuration(raw) {
  const s = txt(raw)
  if (!s) return null
  const months = /(\d+)\s*month/i.exec(s)
  // "2 work term commitment" counts terms, not months — only match a bare digit
  // directly before "work term".
  const terms = /(\d+)\s*work\s*term/i.exec(s)
  return {
    raw: s,
    months: months ? +months[1] : null,
    terms: terms ? +terms[1] : null,
    consecutive: /consecutive/i.test(s),
    requirement: /required/i.test(s) ? 'required' : /preferred/i.test(s) ? 'preferred' : null,
  }
}

/** "2027 - Winter" -> { raw, year, season } */
function parseWorkTerm(raw) {
  const s = txt(raw)
  if (!s) return null
  const m = /(\d{4})\s*-\s*(\w+)/.exec(s)
  return m ? { raw: s, year: +m[1], season: m[2] } : { raw: s, year: null, season: null }
}

/**
 * "Targeted Clusters\n\n• ENG - Software Engineering\n\n• MATH - Computer Science"
 * -> ["ENG - Software Engineering", "MATH - Computer Science"]
 */
function parseClusters(raw) {
  const s = txt(raw)
  if (!s) return []
  return s
    .split('•')
    .slice(1) // drop the "Targeted Clusters" heading before the first bullet
    .map((c) => c.replace(/\s+/g, ' ').trim().replace(/^-\s*/, ''))
    .filter(Boolean)
}

/** Header cells carry sort-icon glyph names: "Job Titleswap_vert" -> "Job Title" */
const ICON_NAMES =
  /(swap_vert|keyboard_arrow_down|keyboard_arrow_up|unfold_more|arrow_upward|arrow_downward)/g
function cleanKey(k) {
  return String(k).replace(ICON_NAMES, '').replace(/^Select All/, '').trim()
}

function cleanListFields(listFields) {
  const out = {}
  for (const [k, v] of Object.entries(listFields || {})) {
    const key = cleanKey(k)
    if (key && txt(v)) out[key] = txt(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

// Field keys consumed below; anything left over is surfaced as `extra` so a new
// WaterlooWorks field is never silently dropped.
const MAPPED = new Set([
  'Job Title', 'Organization', 'Division', 'Job Type', 'Work Term',
  'Work Term Duration', 'Number of Job Openings', 'Level', 'Region',
  'Job - City', 'Job - Province/State', 'Job - Country', 'Job - Postal/Zip Code',
  'Job - Address Line One', 'Job - Address Line Two',
  'Employment Location Arrangement',
  'Job Location (If Exact Address Unknown or Multiple Locations)',
  'Additional Employment Arrangement Location Information',
  'Application Deadline', 'Application Method', 'Application Documents Required',
  'Additional Application Information',
  'Job Summary', 'Job Responsibilities', 'Required Skills',
  'Compensation and Benefits', 'Targeted Degrees and Disciplines',
  'Special Job Requirements', 'Special Work Term Start/End Date Considerations',
  'Transportation and Housing', 'Additional Information',
  'Employer Internal Job Number', 'Additional Job Identifiers',
])

export function normalize(p) {
  const f = p.fields || {}
  const list = cleanListFields(p.listFields)

  const extra = {}
  for (const [k, v] of Object.entries(f)) if (!MAPPED.has(k)) extra[k] = v

  return {
    id: String(p.id),
    title: txt(f['Job Title']) || txt(p.title),
    organization: txt(f['Organization']),
    division: txt(f['Division']),
    jobType: txt(f['Job Type']),

    workTerm: parseWorkTerm(f['Work Term']),
    duration: parseDuration(f['Work Term Duration']),
    openings: toInt(f['Number of Job Openings']),
    applicants: toInt(list['Apps']),
    levels: asArray(f['Level']).flatMap((l) => l.split(',').map((x) => x.trim())).filter(Boolean),

    location: {
      city: txt(f['Job - City']) || txt(list['City']),
      province: txt(f['Job - Province/State']),
      country: txt(f['Job - Country']),
      region: txt(f['Region']),
      postalCode: txt(f['Job - Postal/Zip Code']),
      addressLines: [f['Job - Address Line One'], f['Job - Address Line Two']]
        .map(txt)
        .filter(Boolean),
      arrangement: txt(f['Employment Location Arrangement']),
      approximate: txt(f['Job Location (If Exact Address Unknown or Multiple Locations)']),
      note: tidy(f['Additional Employment Arrangement Location Information']),
    },

    deadline: parseDeadline(f['Application Deadline']),
    application: {
      method: txt(f['Application Method']),
      documents: (txt(f['Application Documents Required']) || '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      additionalInfo: tidy(f['Additional Application Information']),
    },

    compensation: tidy(f['Compensation and Benefits']),
    summary: tidy(f['Job Summary']),
    responsibilities: tidy(f['Job Responsibilities']),
    skills: tidy(f['Required Skills']),
    clusters: parseClusters(f['Targeted Degrees and Disciplines']),

    specialRequirements: tidy(f['Special Job Requirements']),
    scheduleNotes: tidy(f['Special Work Term Start/End Date Considerations']),
    transportationHousing: tidy(f['Transportation and Housing']),
    additionalInformation: asArray(f['Additional Information']),
    jobIdentifiers: asArray(f['Additional Job Identifiers']),
    employerJobNumber: txt(f['Employer Internal Job Number']),

    scrapedAt: p.scrapedAt || null,
    ...(Object.keys(extra).length ? { extra } : {}),
  }
}

// A record this module already produced, rather than a raw scrape. Re-importing
// an exported postings.clean.json is a reasonable thing to do (it's the small
// file, and it's what you'd keep), and running `normalize` over it a second
// time would blank every field — the raw shape nests everything under `fields`,
// the normalized one doesn't have that key at all.
function looksNormalized(p) {
  return p != null && p.fields === undefined && (
    'organization' in p || 'location' in p || 'summary' in p
  )
}

// A normalized record always has its sub-objects and arrays present, which is
// what lets the table and detail panel read `r.location.city` or `r.levels.join`
// without guarding every access. Records coming back in through the
// already-normalized path haven't been through `normalize`, so a truncated or
// hand-edited file could otherwise reach the UI missing one of them and take
// the whole section down. Fill the holes instead.
function ensureShape(p) {
  return {
    ...p,
    levels: Array.isArray(p.levels) ? p.levels : [],
    clusters: Array.isArray(p.clusters) ? p.clusters : [],
    additionalInformation: Array.isArray(p.additionalInformation) ? p.additionalInformation : [],
    jobIdentifiers: Array.isArray(p.jobIdentifiers) ? p.jobIdentifiers : [],
    location: { addressLines: [], ...(p.location || {}) },
    application: { documents: [], ...(p.application || {}) },
  }
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/** Postings array out of any shape the scraper or this module writes. */
function postingsOf(doc) {
  if (Array.isArray(doc)) return doc
  if (doc && Array.isArray(doc.postings)) return doc.postings
  return []
}

/**
 * Merge any number of scrape documents into one de-duplicated dataset.
 *
 * `docs` is [{ name, doc }] — name only for the sources list in the report.
 * De-duplication is by posting ID with the newest scrape winning, so importing
 * a partial scrape and a full one (in either order) is safe.
 *
 * `into` seeds the merge with postings that are already imported, which is what
 * makes "Import more" additive. Those aren't counted as read or listed as a
 * source: they came from files, but not from these ones.
 */
export function mergeDocuments(docs, { keepRaw = false, into = [] } = {}) {
  const byId = new Map()
  const sources = []
  let read = 0
  let duplicates = 0
  const skipped = []

  for (const r of into) byId.set(String(r.id), { ...r, _scrapedAt: r.scrapedAt || '' })

  for (const { name, doc } of docs) {
    const postings = postingsOf(doc)
    if (!postings.length) {
      skipped.push({ name, reason: 'no postings array in this file' })
      continue
    }
    sources.push({ name, count: postings.length })

    for (const p of postings) {
      if (!p || p.id == null) continue
      read++
      const id = String(p.id)
      const prev = byId.get(id)
      if (prev) {
        duplicates++
        // newest scrape wins
        if ((p.scrapedAt || '') <= (prev._scrapedAt || '')) continue
      }

      const rec = looksNormalized(p) ? ensureShape({ ...p, id }) : normalize(p)
      rec._scrapedAt = p.scrapedAt || ''
      if (keepRaw && p.raw && p.raw.text) rec.rawText = p.raw.text
      byId.set(id, rec)
    }
  }

  const postings = [...byId.values()]
    .map(({ _scrapedAt, ...r }) => r)
    .sort(byDeadlineThenId)

  return { postings, read, duplicates, sources, skipped }
}

function byDeadlineThenId(a, b) {
  const d = (a.deadline && a.deadline.date ? a.deadline.date : '9999').localeCompare(
    b.deadline && b.deadline.date ? b.deadline.date : '9999'
  )
  return d || String(a.id).localeCompare(String(b.id))
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const COMPLETENESS = [
  ['title', (r) => r.title],
  ['summary', (r) => r.summary],
  ['skills', (r) => r.skills],
  ['deadline date', (r) => r.deadline && r.deadline.date],
  ['city', (r) => r.location && r.location.city],
  ['clusters', (r) => r.clusters && r.clusters.length],
  ['duration months', (r) => r.duration && r.duration.months],
]

/** Descending [value, count] pairs for a field that may be scalar or array. */
export function tally(rows, get) {
  const m = new Map()
  for (const r of rows) {
    const v = get(r)
    for (const x of Array.isArray(v) ? v : [v]) {
      if (!x) continue
      m.set(x, (m.get(x) || 0) + 1)
    }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

/**
 * The same summary `tools/clean.js` printed after writing its files: how much
 * came in, what's missing, and which WaterlooWorks fields this pipeline doesn't
 * map yet. The last one matters — an unmapped field is a field that silently
 * stopped being extracted when WaterlooWorks renamed it.
 */
export function buildReport(rows, { read = 0, duplicates = 0, sources = [], skipped = [] } = {}) {
  const withExtra = rows.filter((r) => r.extra)
  const unmappedKeys = new Set()
  for (const r of withExtra) for (const k of Object.keys(r.extra)) unmappedKeys.add(k)

  return {
    count: rows.length,
    read,
    duplicates,
    sources,
    skipped,
    missing: COMPLETENESS
      .map(([label, fn]) => ({ label, n: rows.filter((r) => !fn(r)).length }))
      .filter((m) => m.n > 0),
    arrangements: tally(rows, (r) => r.location && r.location.arrangement),
    cities: tally(rows, (r) => r.location && r.location.city),
    levels: tally(rows, (r) => r.levels),
    unmapped: { count: withExtra.length, keys: [...unmappedKeys] },
  }
}

// ---------------------------------------------------------------------------
// csv
// ---------------------------------------------------------------------------
export const CSV_COLUMNS = [
  ['id', (r) => r.id],
  ['title', (r) => r.title],
  ['organization', (r) => r.organization],
  ['division', (r) => r.division],
  ['city', (r) => r.location.city],
  ['province', (r) => r.location.province],
  ['country', (r) => r.location.country],
  ['arrangement', (r) => r.location.arrangement],
  ['levels', (r) => r.levels.join('; ')],
  ['openings', (r) => r.openings],
  ['applicants', (r) => r.applicants],
  ['deadline', (r) => r.deadline && r.deadline.date],
  ['durationMonths', (r) => r.duration && r.duration.months],
  ['workTerm', (r) => r.workTerm && r.workTerm.raw],
  ['clusters', (r) => r.clusters.join('; ')],
  ['documents', (r) => r.application.documents.join('; ')],
  // AI-normalized compensation. `hourlyCad` is the display string ("25.00",
  // "25.00-30.00" or "NA"); min/max are broken out so a spreadsheet can sort and
  // filter on them without parsing the range back apart.
  ['hourlyCad', (r) => r.hourlyCad && r.hourlyCad.text],
  ['hourlyCadMin', (r) => r.hourlyCad && r.hourlyCad.min],
  ['hourlyCadMax', (r) => r.hourlyCad && r.hourlyCad.max],
  ['hourlyCadBasis', (r) => r.hourlyCad && r.hourlyCad.basis],
  ['hourlyCadNote', (r) => r.hourlyCad && r.hourlyCad.note],
]

export function toCsv(rows) {
  const esc = (v) => {
    if (v == null) return ''
    const s = String(v).replace(/\s+/g, ' ').trim()
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')]
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => esc(get(r))).join(','))
  return lines.join('\n') + '\n'
}

/** The postings.clean.json document, byte-for-byte what the CLI wrote. */
export function toCleanJson(rows, sources) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      count: rows.length,
      sources: (sources || []).map((s) => s.name),
      postings: rows,
    },
    null,
    2
  )
}

// ---------------------------------------------------------------------------
// browsing: search, filter, sort
// ---------------------------------------------------------------------------

// Free-text search runs over these, joined once per posting and cached on the
// record — re-joining 2000 postings' full text on every keystroke is the one
// thing here big enough to feel slow.
const HAYSTACK = (r) =>
  [
    r.id, r.title, r.organization, r.division, r.jobType,
    r.location.city, r.location.province, r.location.country, r.location.arrangement,
    r.summary, r.responsibilities, r.skills, r.compensation,
    r.levels.join(' '), r.clusters.join(' '),
    // so "NA", or a note naming a currency we couldn't convert, is searchable
    r.hourlyCad && r.hourlyCad.text, r.hourlyCad && r.hourlyCad.note,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

const haystacks = new WeakMap()
function haystack(r) {
  let h = haystacks.get(r)
  if (h === undefined) {
    h = HAYSTACK(r)
    haystacks.set(r, h)
  }
  return h
}

export const EMPTY_FILTERS = {
  query: '',
  arrangement: '',
  city: '',
  level: '',
  cluster: '',
  deadlineFrom: '',
  minMonths: '',
  minHourly: '',
}

/**
 * All filters are ANDed; a blank filter is inactive. Every term in the query
 * must appear somewhere in the posting, so "toronto python" narrows rather than
 * widens.
 */
export function filterPostings(rows, filters) {
  const f = { ...EMPTY_FILTERS, ...filters }
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean)
  const minMonths = f.minMonths === '' ? null : Number(f.minMonths)
  const minHourly = f.minHourly === '' ? null : Number(f.minHourly)

  return rows.filter((r) => {
    if (f.arrangement && r.location.arrangement !== f.arrangement) return false
    if (f.city && r.location.city !== f.city) return false
    if (f.level && !r.levels.includes(f.level)) return false
    if (f.cluster && !r.clusters.includes(f.cluster)) return false
    if (f.deadlineFrom) {
      const d = r.deadline && r.deadline.date
      // A posting with no parsed deadline can't be shown to meet a date floor.
      if (!d || d < f.deadlineFrom) return false
    }
    if (minMonths != null && !Number.isNaN(minMonths)) {
      const m = r.duration && r.duration.months
      if (m == null || m < minMonths) return false
    }
    if (minHourly != null && !Number.isNaN(minHourly)) {
      // Compare on the TOP of the range: a posting advertising 18-32/hr does meet
      // a floor of 30, and judging it on its minimum would hide it.
      const top = r.hourlyCad && r.hourlyCad.max
      if (top == null || top < minHourly) return false
    }
    if (terms.length) {
      const h = haystack(r)
      for (const t of terms) if (!h.includes(t)) return false
    }
    return true
  })
}

export const SORTS = {
  deadline: (r) => (r.deadline && r.deadline.date) || '9999-99-99',
  title: (r) => (r.title || '').toLowerCase(),
  organization: (r) => (r.organization || '').toLowerCase(),
  city: (r) => (r.location.city || '').toLowerCase(),
  arrangement: (r) => (r.location.arrangement || '').toLowerCase(),
  openings: (r) => r.openings,
  applicants: (r) => r.applicants,
  durationMonths: (r) => r.duration && r.duration.months,
  // Sorted on the top of the range, matching how the minHourly filter reads it.
  hourlyCad: (r) => (r.hourlyCad ? r.hourlyCad.max : null),
  id: (r) => Number(r.id) || 0,
}

export function sortPostings(rows, key, dir = 'asc') {
  const get = SORTS[key] || SORTS.deadline
  const sign = dir === 'desc' ? -1 : 1
  // Nulls sort last in both directions — an unknown value is never "the
  // smallest", it's just unknown, and floating them to the top buries the rows
  // you asked to see.
  return [...rows].sort((a, b) => {
    const x = get(a)
    const y = get(b)
    if (x == null && y == null) return String(a.id).localeCompare(String(b.id))
    if (x == null) return 1
    if (y == null) return -1
    if (x === y) return String(a.id).localeCompare(String(b.id))
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sign
  })
}
