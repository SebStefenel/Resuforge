// Cloud persistence for a user's resumes. Each resume is one row keyed by its
// own `id`; `user_id` is the owner column that RLS filters on.
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient'

// Every resume belonging to this user, newest-updated first. Deliberately does
// not select the document body — the switcher only needs names.
export async function listResumes(userId) {
  const { data, error } = await supabase
    .from('resumes')
    .select('id, resume_name, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

// Returns null if the row is gone (deleted in another tab, say).
export async function loadResume(resumeId) {
  const { data, error } = await supabase
    .from('resumes')
    .select('id, resume_name, template, categories, selected, category_order')
    .eq('id', resumeId)
    .maybeSingle()
  if (error) throw error
  return data
}

// Inserts a new resume and returns its row (id included).
export async function createResume(userId, doc) {
  const { data, error } = await supabase
    .from('resumes')
    .insert({ user_id: userId, ...bodyOf(doc) })
    .select('id, resume_name, updated_at')
    .single()
  if (error) throw error
  return data
}

export async function deleteResume(resumeId) {
  const { error } = await supabase.from('resumes').delete().eq('id', resumeId)
  if (error) throw error
}

function bodyOf({ resumeName, template, categories, selected }) {
  return {
    resume_name: resumeName,
    template,
    categories,
    selected,
    // Explicit display order for the Variants panel. jsonb re-sorts object
    // keys, so the order of `categories` alone can't be trusted on the way
    // back out — see migration 0003.
    category_order: Object.keys(categories ?? {}),
  }
}

function rowFor(resumeId, userId, doc) {
  return { id: resumeId, user_id: userId, ...bodyOf(doc) }
}

export async function saveResume(resumeId, userId, doc) {
  const { error } = await supabase.from('resumes').upsert(rowFor(resumeId, userId, doc))
  if (error) throw error
}

// ── Local mirror ────────────────────────────────────────────────────────────
// A copy of the last known-good document, written to this browser on every
// successful save. Supabase overwrites a resume's row in place, so a bad write
// leaves nothing to fall back on. This is that fallback — it lives outside the
// database entirely and is never written when the document is empty, so a
// blank state can't erase a good backup.
//
// Keyed per resume, so switching between resumes can't cross-contaminate one
// document's backup with another's.

const backupKey = (resumeId) => `resuforge_backup_${resumeId}`

export function writeLocalBackup(resumeId, doc) {
  try {
    localStorage.setItem(
      backupKey(resumeId),
      JSON.stringify({ ...doc, savedAt: new Date().toISOString() })
    )
  } catch {
    // Quota or private-mode failures are non-fatal; the mirror is best-effort.
  }
}

export function readLocalBackup(resumeId) {
  try {
    const raw = localStorage.getItem(backupKey(resumeId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearLocalBackup(resumeId) {
  try { localStorage.removeItem(backupKey(resumeId)) } catch {}
}

// Last-ditch save when the page is going away (tab close, navigation).
// A normal await'd request is killed the moment the document unloads, so this
// goes straight to PostgREST with `keepalive: true` — the same upsert
// supabase-js would issue, just flagged to outlive the page.
//
// keepalive bodies are capped at 64KB by the spec; oversized documents fall
// back to a plain request, which usually still lands but isn't guaranteed.
// Returns false if it couldn't even attempt the write.
export function saveResumeOnUnload(resumeId, userId, doc, accessToken) {
  if (!accessToken || !resumeId) return false
  const body = JSON.stringify(rowFor(resumeId, userId, doc))
  try {
    fetch(`${SUPABASE_URL}/rest/v1/resumes`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        // Makes the INSERT behave as an upsert on the `id` primary key.
        Prefer: 'resolution=merge-duplicates',
      },
      body,
      keepalive: body.length < 60000,
    })
    return true
  } catch {
    return false
  }
}