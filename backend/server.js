const express = require('express')
const cors = require('cors')
const archiver = require('archiver')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

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

// Build the cartesian product of the given categories' presets.
// Returns an array of combinations; each combination is an array of
// { cat, presetName, value }. With no categories, returns [[]] (one empty combo).
function cartesianCombos(categories, catNames) {
  let combos = [[]]
  for (const cat of catNames) {
    const presets = Object.entries(categories[cat].presets) // [presetName, value]
    const next = []
    for (const combo of combos) {
      for (const [presetName, value] of presets) {
        next.push([...combo, { cat, presetName, value }])
      }
    }
    combos = next
  }
  return combos
}

// Turn an arbitrary name into a filesystem/zip-safe path segment.
const safeSeg = (s) => String(s).replace(/[^a-zA-Z0-9_.\- ]/g, '_').trim() || '_'

const MAX_COMBINATIONS = 300

// Compile every combination of variant presets and stream a ZIP with a nested
// folder layout: resumes/{cat1}:{preset}/{cat2}:{preset}/.../resume.pdf
app.post('/api/compile-all', async (req, res) => {
  const { template, categories, filename, layout } = req.body
  if (!template || typeof template !== 'string') {
    return res.status(400).json({ error: 'No template provided' })
  }
  const cats = categories && typeof categories === 'object' ? categories : {}

  // Base name for each PDF inside the zip (defaults to "resume").
  const pdfBase = safeSeg(typeof filename === 'string' ? filename : 'resume') || 'resume'

  // Folder layout:
  //   'nested' -> resumes/{cat}:{preset}/{cat}:{preset}/... (depth = #categories)
  //   'flat'   -> resumes/{cat}:{preset}__{cat}:{preset}/    (always depth 2)
  const layoutMode = layout === 'flat' ? 'flat' : 'nested'

  // Only vary categories that have at least one preset AND whose placeholder
  // actually appears in the template — those are the ones that change output.
  const catNames = Object.keys(cats).filter(c =>
    cats[c] && cats[c].presets &&
    Object.keys(cats[c].presets).length > 0 &&
    template.includes(`{{${c}}}`)
  )

  const combos = cartesianCombos(cats, catNames)

  if (combos.length > MAX_COMBINATIONS) {
    return res.status(400).json({
      error: `That's ${combos.length} combinations, above the limit of ${MAX_COMBINATIONS}. ` +
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

  for (const combo of combos) {
    if (archiveErr) break

    // Resolve the template for this combination.
    let latex = template
    for (const { cat, value } of combo) {
      latex = latex.split(`{{${cat}}}`).join(value)
    }

    // Folder path encoding the combination, per the requested layout.
    let folder
    if (combo.length === 0) {
      folder = 'resumes'
    } else {
      const pairs = combo.map(c => `${safeSeg(c.cat)}:${safeSeg(c.presetName)}`)
      folder = layoutMode === 'flat'
        ? `resumes/${pairs.join('__')}`     // one folder per combination, depth 2
        : 'resumes/' + pairs.join('/')      // nested by category
    }

    const result = compileToPdf(latex)
    if (result.pdf) {
      archive.append(result.pdf, { name: `${folder}/${pdfBase}.pdf` })
    } else {
      // Don't fail the whole zip for one bad combo — include the error log.
      archive.append(
        `This combination failed to compile.\n\n${result.log || result.error || 'Unknown error'}`,
        { name: `${folder}/COMPILE_ERROR.txt` }
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
