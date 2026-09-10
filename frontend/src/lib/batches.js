// A workspace of named batches over one shared pool of postings.
//
// Postings live once, in `postings`, keyed by id. A batch is a name plus a list
// of those ids. That matters for what this feature is for: an AI screen turns
// 574 postings into a subset, and doing that by copying records would duplicate
// megabytes per batch and — worse — fork them, so normalizing pay in one batch
// would leave the same posting stale in another. With a shared pool, a posting
// is enriched once and every batch that references it sees the result.
//
// Shape:
//   { version: 2,
//     postings: { [id]: posting },
//     batches: [{ id, name, ids: [], createdAt, origin, report?, judgments? }],
//     activeId }
//
// `origin` records where a batch came from — an import, an AI screen (with the
// question and the fields it was given), or a manual edit — so a batch can
// always explain itself.

import { mergeDocuments, buildReport } from './wwClean'

export const newId = () =>
  `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export const emptyWorkspace = () => ({ version: 2, postings: {}, batches: [], activeId: null })

/**
 * Bring forward whatever is in storage. Version 1 was a single dataset
 * ({ postings: [], report, sources, importedAt }); it becomes a pool plus one
 * batch, so an existing import — including pay figures already normalized
 * against it — survives untouched.
 */
export function migrate(stored) {
  if (!stored) return null
  if (stored.version === 2) return stored

  const pool = {}
  for (const p of stored.postings || []) pool[String(p.id)] = p
  const id = newId()
  return {
    version: 2,
    postings: pool,
    batches: [{
      id,
      name: 'All postings',
      ids: Object.keys(pool),
      createdAt: stored.importedAt || new Date().toISOString(),
      origin: { kind: 'import', sources: stored.sources || [] },
      report: stored.report || null,
    }],
    activeId: id,
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

export const getBatch = (ws, id) => (ws.batches || []).find((b) => b.id === id) || null
export const activeBatch = (ws) => getBatch(ws, ws.activeId) || (ws.batches || [])[0] || null

/** Postings of a batch, in pool order, skipping ids the pool no longer has. */
export function batchPostings(ws, batchId) {
  const b = getBatch(ws, batchId)
  if (!b) return []
  const out = []
  for (const id of b.ids) {
    const p = ws.postings[id]
    if (p) out.push(p)
  }
  return out
}

/** A name that doesn't collide with an existing batch. */
export function uniqueName(ws, wanted) {
  const taken = new Set((ws.batches || []).map((b) => b.name))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n++) if (!taken.has(`${wanted} (${n})`)) return `${wanted} (${n})`
}

// ── writes (all pure: they return a new workspace) ───────────────────────────

/**
 * Import parsed JSON documents into the pool and create a batch over exactly
 * what those files contained.
 *
 * Postings already in the pool are updated by the same newest-scrape-wins rule
 * the importer has always used, but enrichment already computed for them (the
 * normalized wage) is carried across, so re-importing a scrape does not throw
 * away work the AI was paid to do.
 */
export function addImportBatch(ws, docs, { name } = {}) {
  const merged = mergeDocuments(docs)
  const postings = { ...ws.postings }
  const ids = []

  for (const rec of merged.postings) {
    const id = String(rec.id)
    const prev = postings[id]
    postings[id] = prev && prev.hourlyCad && !rec.hourlyCad ? { ...rec, hourlyCad: prev.hourlyCad } : rec
    ids.push(id)
  }

  const batch = {
    id: newId(),
    name: uniqueName(ws, name || defaultImportName(merged.sources)),
    ids,
    createdAt: new Date().toISOString(),
    origin: { kind: 'import', sources: merged.sources },
    report: buildReport(merged.postings, merged),
  }
  return {
    ws: { ...ws, postings, batches: [...ws.batches, batch], activeId: batch.id },
    merged,
    batch,
  }
}

function defaultImportName(sources) {
  if (!sources || !sources.length) return 'Imported'
  const base = sources[0].name.replace(/\.json$/i, '')
  return sources.length === 1 ? base : `${base} +${sources.length - 1}`
}

/** A batch over a subset of an existing one — what an AI screen produces. */
export function deriveBatch(ws, { name, ids, origin, judgments }) {
  const batch = {
    id: newId(),
    name: uniqueName(ws, name),
    ids: [...ids],
    createdAt: new Date().toISOString(),
    origin,
    ...(judgments ? { judgments } : {}),
  }
  return { ws: { ...ws, batches: [...ws.batches, batch], activeId: batch.id }, batch }
}

/**
 * Drop postings from a batch. The records stay in the pool: another batch may
 * reference them, and removing one from a shortlist is not a statement that the
 * posting never existed.
 */
export function removeFromBatch(ws, batchId, idsToRemove) {
  const drop = new Set(idsToRemove.map(String))
  return {
    ...ws,
    batches: ws.batches.map((b) =>
      b.id === batchId
        ? { ...b, ids: b.ids.filter((id) => !drop.has(id)), origin: { ...b.origin, edited: true } }
        : b
    ),
  }
}

export function renameBatch(ws, batchId, name) {
  const clean = String(name || '').trim()
  if (!clean) return ws
  return {
    ...ws,
    batches: ws.batches.map((b) => (b.id === batchId ? { ...b, name: clean } : b)),
  }
}

/**
 * Delete a batch, and with it any posting no other batch still references —
 * otherwise the pool would only ever grow.
 */
export function deleteBatch(ws, batchId) {
  const batches = ws.batches.filter((b) => b.id !== batchId)
  const keep = new Set()
  for (const b of batches) for (const id of b.ids) keep.add(id)

  const postings = {}
  for (const [id, p] of Object.entries(ws.postings)) if (keep.has(id)) postings[id] = p

  const activeId = ws.activeId === batchId ? (batches[0]?.id ?? null) : ws.activeId
  return { ...ws, postings, batches, activeId }
}

export const setActive = (ws, batchId) => ({ ...ws, activeId: batchId })

/**
 * Write enriched records back into the pool. Used by the compensation run, whose
 * results belong to the posting rather than to the batch it was launched from.
 */
export function updatePostings(ws, updated) {
  const postings = { ...ws.postings }
  for (const p of updated) postings[String(p.id)] = p
  return { ...ws, postings }
}
