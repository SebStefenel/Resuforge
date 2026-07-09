const express = require('express')
const cors = require('cors')
const archiver = require('archiver')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' })) // batch export can send many resolved documents

const TEMP_DIR = path.join(__dirname, 'temp')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR)

// Generous timeout: the FIRST time a document uses a package that isn't in
// MiKTeX's base install, pdflatex auto-downloads it inline, which can take a
// while. Subsequent compiles hit the local cache and are fast.
const COMPILE_TIMEOUT = 180000 // 3 minutes

// Compile a LaTeX string to a PDF. Returns { pdf: Buffer } on success, or
// { error, log } if no PDF was produced. Never throws.
function compileToPdf(latex) {
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
  const runPdflatex = () => {
    try {
      execSync(
        `pdflatex -interaction=nonstopmode -output-directory="${dir}" "${texFile}"`,
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
      return { pdf: fs.readFileSync(pdfFile) }
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

app.post('/api/compile', (req, res) => {
  const { latex } = req.body
  if (!latex) return res.status(400).json({ error: 'No latex provided' })

  try {
    const result = compileToPdf(latex)
    if (result.pdf) {
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
app.post('/api/compile-all', async (req, res) => {
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

const PORT = 3001
const server = app.listen(PORT, () => console.log(`ResuForge backend running on http://localhost:${PORT}`))

// A first-time compile can run for a few minutes while MiKTeX downloads
// packages. Disable Node's request/socket timeouts (default requestTimeout is
// 300s) so the request isn't aborted mid-compile — the per-run execSync
// timeout in the handler still bounds how long pdflatex itself can run.
server.requestTimeout = 0
server.headersTimeout = 0
server.timeout = 0
