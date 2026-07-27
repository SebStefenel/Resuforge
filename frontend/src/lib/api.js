// Wrapper around fetch() for the compile backend: attaches the Supabase
// bearer token (the backend requires it) and targets VITE_API_URL, which is
// blank in dev so calls stay relative and go through the Vite proxy to the
// local backend, and set to the Fly.io URL in production.
import { supabase } from './supabaseClient'

export const API_URL = import.meta.env.VITE_API_URL || ''

export async function authFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { ...(options.headers || {}) }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return fetch(`${API_URL}${path}`, { ...options, headers })
}
