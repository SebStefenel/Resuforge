// The user's AI provider settings, stored per account in Supabase so they
// follow the user to any machine they sign in from. Row-level security makes the
// row owner-only; see supabase/migrations/0004_ai_settings.sql.
import { supabase } from './supabaseClient'

export const DEFAULT_AI_SETTINGS = {
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  glmKey: '',
  glmModel: 'glm-4.6',
  // The Coding Plan is entitled on the Anthropic-compatible route, not on
  // /paas/v4 (which bills against account balance). See glmProtocol in ai.js.
  glmBaseUrl: 'https://api.z.ai/api/anthropic',
  usdCad: 1.37,
  hoursPerWeek: 40,
}

const fromRow = (r) => ({
  geminiKey: r.gemini_key ?? '',
  geminiModel: r.gemini_model || DEFAULT_AI_SETTINGS.geminiModel,
  glmKey: r.glm_key ?? '',
  glmModel: r.glm_model || DEFAULT_AI_SETTINGS.glmModel,
  glmBaseUrl: r.glm_base_url || DEFAULT_AI_SETTINGS.glmBaseUrl,
  // numeric comes back as a string from PostgREST.
  usdCad: Number(r.usd_cad) || DEFAULT_AI_SETTINGS.usdCad,
  hoursPerWeek: Number(r.hours_per_week) || DEFAULT_AI_SETTINGS.hoursPerWeek,
})

const toRow = (userId, s) => ({
  user_id: userId,
  gemini_key: s.geminiKey ?? '',
  gemini_model: s.geminiModel || DEFAULT_AI_SETTINGS.geminiModel,
  glm_key: s.glmKey ?? '',
  glm_model: s.glmModel || DEFAULT_AI_SETTINGS.glmModel,
  glm_base_url: s.glmBaseUrl || DEFAULT_AI_SETTINGS.glmBaseUrl,
  usd_cad: Number(s.usdCad) || DEFAULT_AI_SETTINGS.usdCad,
  hours_per_week: Number(s.hoursPerWeek) || DEFAULT_AI_SETTINGS.hoursPerWeek,
})

/**
 * Never throws: a missing table (the migration hasn't been applied yet) or a
 * network failure must not take down the page, since everything else in the app
 * works fine without AI. Returns { settings, error }.
 */
export async function loadAiSettings(userId) {
  try {
    const { data, error } = await supabase
      .from('ai_settings')
      .select('gemini_key, gemini_model, glm_key, glm_model, glm_base_url, usd_cad, hours_per_week')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw error
    return { settings: data ? fromRow(data) : { ...DEFAULT_AI_SETTINGS }, error: null }
  } catch (err) {
    return { settings: { ...DEFAULT_AI_SETTINGS }, error: err.message || String(err) }
  }
}

export async function saveAiSettings(userId, settings) {
  const { error } = await supabase.from('ai_settings').upsert(toRow(userId, settings))
  if (error) throw error
}
