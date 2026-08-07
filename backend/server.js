const express = require('express')
const cors = require('cors')
const archiver = require('archiver')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { v4: uuidv4 } = require('uuid')

const app = express()

// In production, restrict to the deployed frontend origin(s) (comma-separated
// in ALLOWED_ORIGINS, e.g. "https://resuforge.vercel.app"). Unset in dev so
// the Vite proxy / localhost origins keep working without configuration.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : {}))
app.use(express.json({ limit: '50mb' })) // batch export can send many resolved documents

// Every compile request shells out to pdflatex, so unauthenticated access
// would let anyone run arbitrary compute on this box. Require a valid Supabase
// session, validated against Supabase's auth server rather than decoded
// locally, so this works regardless of the project's JWT signing setup.
//
// This deliberately uses plain fetch instead of @supabase/supabase-js: the
// only thing needed here is one GET /auth/v1/user call, whereas createClient()
// also spins up a realtime client that requires a native WebSocket global
// (Node 22+). Dropping the SDK removes that runtime coupling entirely.
//
// Trailing slashes are stripped so both "https://x.supabase.co" and
// "https://x.supabase.co/" work. Note the value must be the BASE project URL —
// the dashboard's "/rest/v1/" REST endpoint is a different service and will
// 404 here.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

async function requireAuth(req, res, next) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: SUPABASE_URL/SUPABASE_ANON_KEY not set' })
  }
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing bearer token' })

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return res.status(401).json({ error: 'Invalid or expired session' })
    const user = await r.json()
    if (!user?.id) return res.status(401).json({ error: 'Invalid or expired session' })
    req.user = user
    next()
  } catch (e) {
    // Network failure reaching Supabase is a server problem, not a bad token.
    res.status(503).json({ error: 'Could not reach the auth server', log: String(e.message || e) })
  }
}

const TEMP_DIR = path.join(__dirname, 'temp')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR)

// Generous timeout: the FIRST time a document uses a package that isn't in
// MiKTeX's base install, pdflatex auto-downloads it inline, which can take a
// while. Subsequent compiles hit the local cache and are fast.
const COMPILE_TIMEOUT = 180000 // 3 minutes

// Read the SyncTeX map pdflatex produced, as plain text. `-synctex=1` writes
// a gzipped .synctex.gz, but some builds leave an uncompressed .synctex
// instead, so handle both. Returns null if there's nothing usable — SyncTeX is
// a nice-to-have and must never fail a compile.
function readSynctex(dir) {
  try {
    const plain = path.join(dir, 'resume.synctex')
    if (fs.existsSync(plain)) return fs.readFileSync(plain, 'utf-8')

    const gz = path.join(dir, 'resume.synctex.gz')
    if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz)).toString('utf-8')
  } catch {}
  return null
}

// Compile a LaTeX string to a PDF. Returns { pdf: Buffer, synctex: string|null }
// on success, or { error, log } if no PDF was produced. Never throws.
function compileToPdf(latex, { synctex = false } = {}) {
  const id = uuidv4()
  const dir = path.join(TEMP_DIR, id)
  fs.mkdirSync(dir)

  const texFile = path.join(dir, 'resume.tex')
  const pdfFile = path.join(dir, 'resume.pdf')
  const logFile = path.join(dir, 'resume.log')

  fs.writeFileSync(texFile, latex, 'utf-8')

  // In nonstopmode pdflatex never blocks on input (it emergency-stops instead),
  // and it returns non-zero on LaTeX errors even when it still manages to
  // produce a PDF. So we decide success by whether a PDF actually came out.
  const syncFlag = synctex ? '-synctex=1 ' : ''
  const runPdflatex = () => {
    try {
      execSync(
        `pdflatex ${syncFlag}-interaction=nonstopmode -output-directory="${dir}" "${texFile}"`,
        { timeout: COMPILE_TIMEOUT, stdio: 'pipe', cwd: dir }
      )
      return null
    } catch (e) {
      return e
    }
  }

  try {
    // Two passes so page counters / \pageref / lastpage resolve, matching
    // what Overleaf does. The second pass is cheap once packages are cached.
    runPdflatex()
    const err = runPdflatex()

    if (fs.existsSync(pdfFile)) {
      return {
        pdf: fs.readFileSync(pdfFile),
        synctex: synctex ? readSynctex(dir) : null,
      }
    }

    let log = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf-8')
      : (err ? err.message : 'pdflatex produced no output and no log')

    if (err && /ETIMEDOUT/.test(err.message)) {
      log = `Compilation timed out after ${COMPILE_TIMEOUT / 1000}s.\n` +
            `If this was the first compile using a new package, MiKTeX may still ` +
            `have been downloading it — try again.\n\n` + log
    }

    return { error: 'Compilation failed', log: log.split('\n').slice(-60).join('\n') }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

// Two response shapes, chosen by the client:
//
//   { synctex: true } -> JSON { pdf: <base64>, synctex: <string|null> }
//   otherwise         -> raw application/pdf bytes
//
// Click-to-source needs the SyncTeX map alongside the document, and it's far
// too large for a response header, so it has to ride in a JSON body. Keeping
// the raw-PDF default matters: a browser holding an older cached bundle would
// otherwise treat the JSON as a failed compile the moment this deploys.
app.post('/api/compile', requireAuth, (req, res) => {
  const { latex, synctex: wantSynctex } = req.body
  if (!latex) return res.status(400).json({ error: 'No latex provided' })

  try {
    const result = compileToPdf(latex, { synctex: !!wantSynctex })
    if (result.pdf) {
      if (wantSynctex) {
        return res.json({
          pdf: result.pdf.toString('base64'),
          synctex: result.synctex,
        })
      }
      res.set('Content-Type', 'application/pdf')
      return res.send(result.pdf)
    }
    res.status(500).json({ error: result.error, log: result.log })
  } catch (e) {
    // Never let the handler throw without a response — otherwise the client
    // gets an empty body and a confusing "Unexpected end of JSON input".
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Server error while compiling',
        log: String((e && e.stack) || e)
      })
    }
  }
})

const MAX_COMBINATIONS = 300

// Compile a batch of already-resolved documents and stream them back as a ZIP.
// The frontend does all the variant resolution/enumeration/naming (see
// lib/variants.js) and sends jobs: [{ path, latex }], where `path` is the full
// intended location inside the zip, e.g. "resumes/location:toronto/Name.pdf".
app.post('/api/compile-all', requireAuth, async (req, res) => {
  const { jobs } = req.body
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: 'No jobs provided' })
  }
  if (jobs.length > MAX_COMBINATIONS) {
    return res.status(400).json({
      error: `That's ${jobs.length} combinations, above the limit of ${MAX_COMBINATIONS}. ` +
             `Reduce the number of variant categories/presets and try again.`
    })
  }

  res.set('Content-Type', 'application/zip')
  res.set('Content-Disposition', 'attachment; filename="resumes.zip"')

  const archive = archiver('zip', { zlib: { level: 9 } })
  let archiveErr = null
  archive.on('error', (err) => {
    archiveErr = err
    if (!res.headersSent) res.status(500).end()
    else res.end()
  })
  archive.pipe(res)

  for (const job of jobs) {
    if (archiveErr) break
    const path = typeof job?.path === 'string' ? job.path : 'resumes/resume.pdf'
    const latex = typeof job?.latex === 'string' ? job.latex : ''

    const result = compileToPdf(latex)
    if (result.pdf) {
      archive.append(result.pdf, { name: path })
    } else {
      // Don't fail the whole zip for one bad combo — include the error log
      // alongside it (same folder).
      const errName = path.replace(/\.pdf$/i, '') + '__COMPILE_ERROR.txt'
      archive.append(
        `This combination failed to compile.\n\n${result.log || result.error || 'Unknown error'}`,
        { name: errName }
      )
    }
  }

  await archive.finalize()
})

const PORT = process.env.PORT || 3001
const server = app.listen(PORT, () => console.log(`ResuForge backend running on http://localhost:${PORT}`))

// A first-time compile can run for a few minutes while MiKTeX downloads
// packages. Disable Node's request/socket timeouts (default requestTimeout is
// 300s) so the request isn't aborted mid-compile — the per-run execSync
// timeout in the handler still bounds how long pdflatex itself can run.
server.requestTimeout = 0
server.headersTimeout = 0
server.timeout = 0
