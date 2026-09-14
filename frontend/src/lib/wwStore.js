// Local persistence for the WaterlooWorks workspace: a pool of postings plus the
// named batches over it (see batches.js).
//
// This lives in IndexedDB rather than in Supabase alongside the resumes, for two
// reasons: a full scrape normalizes to a couple of megabytes, which is a lot to
// push into a jsonb column and pull back on every page load; and the dataset is a
// local artifact to begin with — it came from a file the scraper wrote on this
// machine, and re-importing it is a two-click operation. What's worth syncing is
// a decision made *from* the data, not the data.
//
// localStorage is not an option at this size (a 5MB-ish cap, and it's
// synchronous — writing 2MB would jank the page).
//
// Keyed by user id so two accounts sharing a browser don't see each other's
// imports.
import { migrate, emptyWorkspace } from './batches'

const DB_NAME = 'resuforge_ww'
const DB_VERSION = 1
const STORE = 'datasets'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Resolves when the transaction COMMITS, not when the request succeeds.
//
// Those are not the same moment, and the gap is where data goes missing: a put
// fires onsuccess well before the transaction commits, and the commit can still
// fail afterwards — QuotaExceededError aborts the transaction once every request
// in it has already reported success. Resolving on the request meant a 3MB
// workspace could report itself saved when nothing had been written, and the
// "couldn't save" warning would never appear.
function op(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        let result
        const done = (fn2) => (arg) => { try { db.close() } catch {} ; fn2(arg) }

        const req = fn(tx.objectStore(STORE))
        req.onsuccess = () => { result = req.result }
        req.onerror = () => done(reject)(req.error)

        tx.oncomplete = () => done(resolve)(result)
        tx.onabort = () => done(reject)(tx.error || new Error('IndexedDB transaction aborted'))
        tx.onerror = () => done(reject)(tx.error || new Error('IndexedDB transaction failed'))
      })
  )
}

/**
 * The workspace, upgraded from whatever version was stored. A version 1 record
 * (one flat dataset) becomes a pool plus a single batch, so an existing import
 * and the pay figures already computed against it carry straight over.
 *
 * Reads resolve to null rather than throwing when storage is unavailable
 * (private windows, blocked site data) — the section has to keep working as a
 * one-shot importer in that case, not break.
 */
export async function loadWorkspace(userId) {
  try {
    return migrate((await op('readonly', (s) => s.get(userId))) || null)
  } catch {
    return null
  }
}

/** Resolves false if the write couldn't happen, so the UI can say so. */
export async function saveWorkspace(userId, workspace) {
  try {
    await op('readwrite', (s) => s.put(workspace, userId))
    return true
  } catch {
    return false
  }
}

export async function clearWorkspace(userId) {
  try {
    await op('readwrite', (s) => s.delete(userId))
    return true
  } catch {
    return false
  }
}

/**
 * Attach a resume snapshot to the workspace, creating the workspace if the user
 * hasn't imported anything yet — sending a resume across before importing
 * postings is a perfectly reasonable order to do things in.
 *
 * Called from the resume editor, which does not hold the workspace in state, so
 * it reads, sets and writes in one go.
 */
export async function attachResume(userId, resume) {
  try {
    const ws = migrate((await op('readonly', (s) => s.get(userId))) || null) || emptyWorkspace()
    const next = { ...ws, resume }
    await op('readwrite', (s) => s.put(next, userId))
    return true
  } catch {
    return false
  }
}
