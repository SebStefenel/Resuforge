import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — see .env.example')
}

export const supabase = createClient(url, anonKey)

// Exported for the unload-time save in resumeStore.js, which has to bypass
// supabase-js to set fetch's `keepalive` flag.
export const SUPABASE_URL = url
export const SUPABASE_ANON_KEY = anonKey
