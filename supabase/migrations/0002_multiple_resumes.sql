-- Allow more than one resume per user.
--
-- 0001 made user_id the primary key, which capped each account at a single
-- row. This gives every resume its own id and demotes user_id to a plain
-- (indexed) owner column. Existing rows are preserved — each becomes that
-- user's first resume.
--
-- The RLS policies from 0001 keep working untouched: they filter on
-- `auth.uid() = user_id`, which is still the ownership column.

alter table public.resumes
  add column if not exists id uuid not null default gen_random_uuid();

alter table public.resumes
  add column if not exists created_at timestamptz not null default now();

-- Swap the primary key from user_id to id.
alter table public.resumes drop constraint if exists resumes_pkey;
alter table public.resumes add primary key (id);

-- user_id is no longer unique, so it needs its own index for the
-- "list my resumes" query.
create index if not exists resumes_user_id_idx on public.resumes (user_id);