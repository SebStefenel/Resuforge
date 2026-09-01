// Wrapper around fetch() for the compile backend: attaches the Supabase
// bearer token (the backend requires it) and targets VITE_API_URL, which is
// blank in dev so calls stay relative and go through the Vite proxy to the
// local backend, and set to the Fly.io URL in production.
//
// Supabase access tokens are short-lived (about an hour). supabase-js keeps its
// own token fresh for database calls, but requests we build by hand don't get
// that for free — a tab left idle would otherwise send an expired token and the
// backend would reject it as "Invalid or expired session". So we refresh before
// sending when the token is close to expiry, and retry once if the server
// rejects it anyway (it may have been rotated out from under us).
import { supabase } from './supabaseClient'

export const API_URL = import.meta.env.VITE_API_URL || ''

// Refresh this many seconds before actual expiry, to cover clock skew and the
// time the request itself spends in flight.
const EXPIRY_MARGIN_S = 60

async function currentToken(forceRefresh = false) {
  let session = null
  try {
    ({ data: { session } } = await supabase.auth.getSession())
  } catch {
    session = null
  }

  const nowS = Math.floor(Date.now() / 1000)
  const expiresAt = session?.expires_at ?? 0
  const nearExpiry = !session || expiresAt - EXPIRY_MARGIN_S <= nowS

  if (forceRefresh || nearExpiry) {
    try {
      const { data, error } = await supabase.auth.refreshSession()
      if (!error && data?.session) session = data.session
    } catch {
      // Keep whatever we had; the request will 401 and surface properly.
    }
  }

  return session?.access_token ?? null
}

function send(path, options, token) {
  const headers = { ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${API_URL}${path}`, { ...options, headers })
}

export async function authFetch(path, options = {}) {
  let res = await send(path, options, await currentToken())

  // A 401 here means the token was rejected, not that anything is wrong with
  // the request. Force a refresh and try once more before giving up.
  if (res.status === 401) {
    const refreshed = await currentToken(true)
    if (refreshed) res = await send(path, options, refreshed)
  }

  return res
}
