// Cloud persistence for the single per-user resume document (template +
// categories + selected + name), replacing the old localStorage blob.
import { supabase } from './supabaseClient'

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

export async function saveResume(userId, { resumeName, template, categories, selected }) {
  const { error } = await supabase
    .from('resumes')
    .upsert({
      user_id: userId,
      resume_name: resumeName,
      template,
      categories,
      selected,
    })
  if (error) throw error
}
