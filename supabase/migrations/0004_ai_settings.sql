-- Per-user AI provider settings: two key slots, Gemini first and GLM as the
-- fallback for when Gemini's free-tier quota is spent.
--
-- One row per user, so user_id is the primary key here (unlike `resumes`, which
-- 0002 moved off that to allow many rows per account).
--
-- These columns hold provider API keys. RLS below is what protects them: the
-- policies are owner-only, matching `resumes`, so the anon key the browser ships
-- with cannot read another account's row. Note they are stored at rest in
-- Postgres rather than encrypted per-user — Supabase encrypts the volume, but a
-- project-wide service_role key would still be able to read them, same as every
-- other table here. The alternative considered was keeping keys in
-- localStorage; these are in the database deliberately, so they follow the user
-- to any machine they sign in from.
create table if not exists public.ai_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- Preferred provider. Called directly from the browser; Google returns CORS
  -- headers on generativelanguage.googleapis.com.
  gemini_key text not null default '',
  gemini_model text not null default 'gemini-2.5-flash',

  -- Fallback. Proxied through the compile backend's /api/ai, because
  -- api.z.ai answers a CORS preflight with no allow-origin header.
  glm_key text not null default '',
  glm_model text not null default 'glm-4.6',
  glm_base_url text not null default 'https://api.z.ai/api/paas/v4',

  -- Pinned in the prompt rather than left to the model's imagination, so a
  -- compensation figure converted today and one converted next week are
  -- comparable, and so a wrong number is a setting you can correct rather than
  -- a hallucination you can't see.
  usd_cad numeric not null default 1.37,
  hours_per_week integer not null default 40,

  updated_at timestamptz not null default now()
);

alter table public.ai_settings enable row level security;

create policy "Users can select own ai settings"
  on public.ai_settings for select
  using (auth.uid() = user_id);

create policy "Users can insert own ai settings"
  on public.ai_settings for insert
  with check (auth.uid() = user_id);

create policy "Users can update own ai settings"
  on public.ai_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own ai settings"
  on public.ai_settings for delete
  using (auth.uid() = user_id);

-- set_updated_at() already exists from 0001.
create trigger ai_settings_set_updated_at
  before update on public.ai_settings
  for each row execute function public.set_updated_at();
