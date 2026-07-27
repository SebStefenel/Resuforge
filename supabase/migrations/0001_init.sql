-- One row per user, mirroring the single localStorage blob the app used to
-- keep (template + categories + selected + resumeName). See frontend/src/App.jsx.
create table if not exists public.resumes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  resume_name text not null default 'resume',
  template text not null default '',
  categories jsonb not null default '{}'::jsonb,
  selected jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.resumes enable row level security;

create policy "Users can select own resume"
  on public.resumes for select
  using (auth.uid() = user_id);

create policy "Users can insert own resume"
  on public.resumes for insert
  with check (auth.uid() = user_id);

create policy "Users can update own resume"
  on public.resumes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own resume"
  on public.resumes for delete
  using (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger resumes_set_updated_at
  before update on public.resumes
  for each row execute function public.set_updated_at();
