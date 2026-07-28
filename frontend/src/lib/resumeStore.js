// Cloud persistence for the single per-user resume document (template +
// categories + selected + name), replacing the old localStorage blob.
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient'

// Returns null if this user has no saved resume yet (first ever sign-in).
export async function loadResume(userId) {
  const { data, error } = await supabase
    .from('resumes')
    .select('resume_name, template, categories, selected')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

function rowFor(userId, { resumeName, template, categories, selected }) {
  return {
    user_id: userId,
    resume_name: resumeName,
    template,
    categories,
    selected,
  }
}

export async function saveResume(userId, doc) {
  const { error } = await supabase.from('resumes').upsert(rowFor(userId, doc))
  if (error) throw error
}

// Last-ditch save when the page is going away (tab close, navigation).
// A normal await'd request is killed the moment the document unloads, so this
// goes straight to PostgREST with `keepalive: true` — the same upsert
// supabase-js would issue, just flagged to outlive the page.
//
// keepalive bodies are capped at 64KB by the spec; oversized documents fall
// back to a plain request, which usually still lands but isn't guaranteed.
// Returns false if it couldn't even attempt the write.
export function saveResumeOnUnload(userId, doc, accessToken) {
  if (!accessToken) return false
  const body = JSON.stringify(rowFor(userId, doc))
  try {
    fetch(`${SUPABASE_URL}/rest/v1/resumes`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        // Makes the INSERT behave as an upsert on the user_id primary key.
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
