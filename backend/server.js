const express = require('express')
const cors = require('cors')
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

app.post('/api/compile', (req, res) => {
  const { latex } = req.body
  if (!latex) return res.status(400).json({ error: 'No latex provided' })

  const id = uuidv4()
  const dir = path.join(TEMP_DIR, id)
  fs.mkdirSync(dir)

  const texFile = path.join(dir, 'resume.tex')
  const pdfFile = path.join(dir, 'resume.pdf')
  const logFile = path.join(dir, 'resume.log')

  fs.writeFileSync(texFile, latex, 'utf-8')

  // Run pdflatex once. In nonstopmode it never blocks on input (it emergency-
  // stops instead), and it returns non-zero on LaTeX errors even when it still
  // manages to produce a PDF. So we don't treat a throw as fatal by itself —
  // we decide based on whether a PDF actually came out.
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
      // A PDF exists -> success, even if pdflatex reported warnings/soft errors.
      const pdf = fs.readFileSync(pdfFile)
      res.set('Content-Type', 'application/pdf')
      return res.send(pdf)
    }

    // No PDF produced -> genuine failure. Surface the log.
    let log = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf-8')
      : (err ? err.message : 'pdflatex produced no output and no log')

    if (err && /ETIMEDOUT/.test(err.message)) {
      log = `Compilation timed out after ${COMPILE_TIMEOUT / 1000}s.\n` +
            `If this was the first compile using a new package, MiKTeX may still ` +
            `have been downloading it — try Recompile again.\n\n` + log
    }

    const shortLog = log.split('\n').slice(-60).join('\n')
    res.status(500).json({ error: 'Compilation failed', log: shortLog })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const PORT = 3001
app.listen(PORT, () => console.log(`ResuForge backend running on http://localhost:${PORT}`))
