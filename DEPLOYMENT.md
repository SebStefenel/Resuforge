# ResuForge Deployment

**Live as of 2026-07-27:**

| | URL |
| --- | --- |
| Frontend | https://resuforge-app.vercel.app (also aliased as `frontend-ten-green-31.vercel.app`) |
| Backend | https://resuforge-backend.fly.dev |
| Supabase | project `qaqfgxuiysfdoikutnqb` |

Verified in production: backend boots, auth returns 401 for missing/invalid
tokens, CORS allows the Vercel origins and blocks others, and `pdflatex`
compiles a real PDF inside the machine. **Not** yet verified: the signed-in
browser flow (sign up → confirm email → compile), which needs a confirmed
account.

Three services:

| Service | Hosts | Why |
| --- | --- | --- |
| **Supabase** | Auth + Postgres | User accounts; stores each user's resume document |
| **Fly.io** | `backend/` | Runs `pdflatex` in Docker — needs a real filesystem + long timeouts, so not serverless |
| **Vercel** | `frontend/` | Static Vite build on a CDN |

There's a deliberate ordering below: Fly must deploy first to learn its URL,
Vercel needs that URL, and Fly then needs Vercel's URL for CORS.

---

## 1. Supabase — DONE

Project `qaqfgxuiysfdoikutnqb`. Schema from
[supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql) is already
applied and verified:

- All six columns exist (`user_id`, `resume_name`, `template`, `categories`, `selected`, `updated_at`).
- RLS is enforced — an anonymous `INSERT` is rejected with Postgres `42501`
  (*new row violates row-level security policy*), and anonymous `SELECT` returns
  zero rows.
- Email provider enabled, signups open.

Credentials are already written to the two gitignored env files (see
*Local development* below).

**One setting to know:** `mailer_autoconfirm` is **off**, so a new account can't
sign in until the confirmation email is clicked. Sign-in will fail with *"Email
not confirmed"* until then. To skip that during testing, turn off **Confirm
email** under Authentication → Sign In / Providers.

Once you have the Vercel URL (step 3), set **Authentication → URL Configuration
→ Site URL** to it, so confirmation emails link to the deployed app rather than
localhost.

The anon key is public by design — it ships inside the JS bundle. RLS is what
protects the data, and it's confirmed working above.

## 2. Fly.io (backend)

```bash
flyctl auth login
cd backend
flyctl apps create resuforge-backend      # or edit `app` in fly.toml to a free name

# Reads the values straight out of backend/.env — no copy-paste mistakes.
set -a && . ./.env && set +a
flyctl secrets set SUPABASE_URL="$SUPABASE_URL" SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"

flyctl deploy
```

> **`SUPABASE_URL` must be the bare project URL — no `/rest/v1/` suffix.**
> The dashboard displays `https://<ref>.supabase.co/rest/v1/` as the REST
> endpoint, but `supabase-js` appends its own service paths. Given the
> `/rest/v1/` form it builds `/rest/v1/auth/v1/user`, which returns
> `404 PGRST125` — so *every* authenticated compile would fail with a 401.
> Same rule applies to `VITE_SUPABASE_URL` on Vercel.

**The first deploy is slow** — the image installs `texlive-full`, so expect
15–30 minutes (final image ~1.8 GB compressed). That's the tradeoff for never
hitting a missing-LaTeX-package error at compile time. Swap `texlive-full` for
`texlive-latex-extra` + specific packages in
[backend/Dockerfile](backend/Dockerfile) if you'd rather trade coverage for
build speed.

> **Node version matters.** The image pins **Node 22**, not 20. Node 20 has no
> native `WebSocket` global, and `@supabase/supabase-js`'s `createClient()`
> builds a realtime client that requires one — on Node 20 the process throws at
> startup and Fly crash-loops it to the restart cap. The backend no longer uses
> that SDK at all (it calls `GET /auth/v1/user` with plain `fetch`, since token
> validation was the only thing it needed), so this can't recur, but don't
> downgrade the base image. Note that changing the `FROM` tag invalidates the
> cached texlive layer and forces a full rebuild.

Note the deployed URL (e.g. `https://resuforge-backend.fly.dev`) for step 3.

`fly.toml` sets `auto_stop_machines`/`min_machines_running = 0`, so the machine
sleeps when idle and you aren't billed for a always-on VM. The tradeoff is a
cold start on the first compile after idle; raise `min_machines_running` to 1
if that's annoying.

## 3. Vercel (frontend)

```bash
vercel login
cd frontend
vercel link
```

Set env vars (repeat each for `production`, `preview`, `development`, or use
the dashboard under **Settings → Environment Variables**):

```bash
# Pipes the values from frontend/.env.local rather than pasting them.
set -a && . ./.env.local && set +a
printf '%s' "$VITE_SUPABASE_URL"      | vercel env add VITE_SUPABASE_URL production
printf '%s' "$VITE_SUPABASE_ANON_KEY" | vercel env add VITE_SUPABASE_ANON_KEY production

# This one is NOT in .env.local (it's empty for local dev) — use the Fly URL
# from step 2, e.g. https://resuforge-backend.fly.dev
vercel env add VITE_API_URL production
```

Then:

```bash
vercel --prod
```

If you connect the GitHub repo through the Vercel dashboard instead, set **Root
Directory** to `frontend` so it picks up [frontend/vercel.json](frontend/vercel.json).

## 4. Close the CORS loop — DONE

```bash
cd backend
flyctl secrets set ALLOWED_ORIGINS=https://<your-app>.vercel.app
```

Currently set to both production aliases. Verified: the allowed origin is
echoed back in `access-control-allow-origin`, and an unknown origin gets no
such header.

> **Gotcha:** `flyctl secrets set --stage` does *not* apply to running
> machines, and a secret staged while a deploy is mid-flight gets skipped by
> that deploy. Symptom: `flyctl secrets list` shows *Deployed* but
> `flyctl ssh console -C "printenv ALLOWED_ORIGINS"` exits 1 and CORS still
> returns `*`. Fix with `flyctl secrets deploy`, which rolls the machines.

**Vercel preview deployments get unique URLs** that aren't in this list, so
previews will fail CORS against the production backend. Add them explicitly if
you start using preview builds.

---

## Local development

Both env files are **already written and gitignored**: `backend/.env` and
`frontend/.env.local`. Nothing to fill in — `VITE_API_URL` is deliberately empty
so requests stay relative and flow through the Vite proxy to `localhost:3001`.

`server.js` doesn't auto-load `.env`, so run it with `--env-file` (Node 20+):

```bash
cd backend && node --env-file=.env server.js
cd frontend && npm run dev
```

If you clone fresh, recreate them from the `.env.example` files in each folder.

Local compiles still need `pdflatex` on PATH (MiKTeX on Windows via
`start.ps1`, or `brew install --cask mactex` on macOS). Only the Fly deployment
gets LaTeX for free via Docker.

## Verifying end to end

Already verified against the live project: schema/columns, RLS enforcement,
backend rejection of bogus and anon-key tokens, and the production build.
Not yet verified (needs a confirmed account): the signed-in save/load
round-trip, and a real `pdflatex` compile on Fly.

1. Open the Vercel URL — you should get the sign-in screen, not the editor.
2. Sign up, confirm the email, sign in. (Sign-in fails with *"Email not
   confirmed"* until you click the link — see step 1's note.)
3. Edit the template, create a variant slot, click **Recompile** → PDF renders.
4. Reload the page. Your template and variants should come back — that's the
   Supabase round-trip working (saves are debounced ~800ms, so don't reload
   instantly after a keystroke).
5. Sign in from a different browser and confirm the same document loads.
6. Confirm the backend rejects anonymous callers:
   ```bash
   curl -i -X POST https://<fly-app>.fly.dev/api/compile \
     -H 'Content-Type: application/json' -d '{"latex":"x"}'
   # expect: HTTP/1.1 401 {"error":"Missing bearer token"}
   ```

## Note on existing local data

Resume data now lives in Supabase, keyed by user. Anything previously saved in
a browser's `localStorage` under `resuforge_state` is **not** migrated and won't
appear after signing in. If you have work in there worth keeping, copy it out of
DevTools (Application → Local Storage) before switching over. Panel widths still
use `localStorage` (`resuforge_layout`) since they're per-device by nature.
