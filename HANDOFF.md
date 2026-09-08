# ResuForge — session handoff

Paste this whole file into the first message of your next Claude Code session.
Verified 2026-09-08; all three services healthy at that time.

## Project

ResuForge: a LaTeX resume builder. You write a template with `{{slot}}`
placeholders, define "variant" categories with swappable presets, and compile
to PDF — either the current selection, or every combination as a ZIP.

Repo: https://github.com/SebStefenel/Resuforge
Local path (old machine): `~/Developer/ApplicationsAPP/Resuforge`

- `frontend/` — Vite + React SPA → Vercel
- `backend/`  — Express, shells out to `pdflatex` → Fly.io (Docker + TeX Live)
- `supabase/migrations/` — schema

## Git state

Branch **`cloud-deployment`**, fully pushed, working tree clean.
HEAD = `2a3dee5`. NOT merged into `main` — decide whether to PR it or keep going
on the branch.

## Live services

| What | Where |
| --- | --- |
| App | https://resuforge-app.vercel.app |
| Backend | https://resuforge-backend.fly.dev |
| Supabase | project `qaqfgxuiysfdoikutnqb` |
| Vercel project | named `frontend` (root dir `frontend/`) |

Old URL `frontend-ten-green-31.vercel.app` still works and still auto-updates.

## FIRST THING ON THE NEW MACHINE

`.env` files are gitignored and will NOT arrive with the clone. Recreate both or
nothing works.

`frontend/.env.local`:
```
VITE_SUPABASE_URL=https://qaqfgxuiysfdoikutnqb.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key — Supabase dashboard → Settings → API>
VITE_API_URL=
```
Leave `VITE_API_URL` EMPTY locally so requests stay relative and go through the
Vite proxy to `localhost:3001`. It is set to the Fly URL in Vercel's env vars
for production.

`backend/.env`:
```
SUPABASE_URL=https://qaqfgxuiysfdoikutnqb.supabase.co
SUPABASE_ANON_KEY=<same anon key>
ALLOWED_ORIGINS=
```

The anon key is public by design (it ships in the JS bundle); RLS is what
protects data. Grab it from the dashboard rather than copying it around.

Also install + log in: `brew install flyctl vercel-cli supabase/tap/supabase`,
then `flyctl auth login` and `vercel login`. The Supabase CLI has never been
logged in — migrations have all been run by hand in the dashboard SQL editor.

Run locally:
```
cd backend  && node --env-file=.env server.js
cd frontend && npm install && npm run dev
```
Local compiles need `pdflatex` on PATH (`brew install --cask mactex`). Only the
Fly image has TeX Live baked in.

## Architecture notes that are easy to get wrong

- **`SUPABASE_URL` must be the BARE project URL.** The dashboard shows
  `https://<ref>.supabase.co/rest/v1/` as the REST endpoint. Using that form
  makes supabase-js build `/rest/v1/auth/v1/user` → 404 PGRST125 → every
  authenticated request 401s. Cost real debugging time once.
- **Backend does NOT use `@supabase/supabase-js`.** `createClient()` builds a
  realtime client needing a native `WebSocket`, which crash-loops on Node 20.
  It validates tokens with plain `fetch` against `/auth/v1/user`. The Docker
  image is pinned to **Node 22** — do not downgrade.
- **Changing the Dockerfile `FROM` tag invalidates the TeX Live layer** and
  forces a ~20 min rebuild.
- **`flyctl secrets set --stage` does not apply to running machines**, and a
  secret staged during an in-flight deploy is skipped silently. `secrets list`
  still says "Deployed". Verify with
  `flyctl ssh console -C "printenv ALLOWED_ORIGINS"`; fix with
  `flyctl secrets deploy`.
- **jsonb does not preserve object key order.** It sorts keys by length then
  bytewise. This silently broke variant ordering, since the Variants panel
  renders in object key order. Order is now stored explicitly in
  `category_order` (a jsonb ARRAY — arrays DO preserve order). Do not go back
  to relying on key order.
- **Vercel preview deploys get unique URLs** that are not in `ALLOWED_ORIGINS`,
  so previews fail CORS against the production backend.
- **Supabase free tier pauses after ~7 days idle.** The project hostname stops
  resolving (NXDOMAIN) and the app shows a bare "Failed to fetch" at sign-in.
  Restore from the dashboard; URL and keys survive unchanged.

## Database

Table `public.resumes`, one row per resume. RLS filters every operation on
`auth.uid() = user_id`.

`id` (uuid PK) · `user_id` · `resume_name` · `template` · `categories` (jsonb)
· `selected` (jsonb) · `category_order` (jsonb array) · `created_at` · `updated_at`

Migrations `0001`, `0002`, `0003` are ALL APPLIED to production (verified).
The Supabase CLI is not linked, so new migrations must be pasted into the
dashboard SQL editor by hand.

**Ordering rule: apply the migration BEFORE deploying frontend code that reads
a new column, or loading breaks for everyone.**

## Deploy

```
# frontend
cd frontend && vercel --prod --yes

# backend (slow: TeX Live)
cd backend && flyctl deploy
```
Fly runs 2 machines, 1 shared CPU / 1GB each, scale-to-zero (idle ≈ $0, ~6 min
idle tail, ~7s cold start). Vercel and Supabase are effectively free at this
usage.

## Known limitations / good next tasks

1. **Concurrency is poor.** `execSync` in `backend/server.js` blocks Node's
   event loop, so one machine = one compile at a time. Measured: ~2.08s per
   two-pass compile, ~1 compile/sec total across 2 machines. 100 simultaneous
   compiles would take ~100s and mostly time out. Fixes, in order of leverage:
   add `[http_service.concurrency]` with `soft_limit = 1` to `fly.toml` (the
   proxy currently stacks ~25 connections onto a machine that handles one),
   raise `flyctl scale count`, and switch `execSync` → async `execFile`.
2. **"Download All" is a self-inflicted DoS.** Up to 300 compiles serially in
   ONE request, 3 min timeout each — can monopolise a machine for 10+ minutes.
   Wants to be a background job.
3. **Load .tex replaces the editor with no confirmation** and now propagates
   straight to the cloud via autosave. A confirm prompt when the editor is
   non-empty was suggested and not built.
4. **`AuthGate` surfaces raw browser errors** like "Failed to fetch". Worth
   catching the network case with a friendlier message.
5. Multi-resume UI (switcher / duplicate / delete) has **never been clicked
   through against live data** — it builds and the migration is proven, but the
   browser flow is unverified.

## Outstanding (both dashboard-only)

- Set **Supabase Site URL** to `https://resuforge-app.vercel.app` so
  confirmation emails link to the right place.
- `mailer_autoconfirm` is OFF, so new signups must confirm by email before they
  can sign in. Toggle **Confirm email** off under Authentication → Sign In /
  Providers if that gets in the way while testing.
