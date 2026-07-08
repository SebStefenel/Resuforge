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

  try {
    // Run twice so references/ToC resolve (most resumes only need one pass)
    execSync(
      `pdflatex -interaction=nonstopmode -output-directory="${dir}" "${texFile}"`,
      { timeout: 30000, stdio: 'pipe' }
    )

    if (!fs.existsSync(pdfFile)) {
      throw new Error('pdflatex ran but no PDF was produced')
    }

    const pdf = fs.readFileSync(pdfFile)
    res.set('Content-Type', 'application/pdf')
    res.send(pdf)
  } catch (err) {
    let log = ''
    if (fs.existsSync(logFile)) {
      log = fs.readFileSync(logFile, 'utf-8')
    }
    // Extract the most useful part of the log (last 60 lines)
    const logLines = log.split('\n')
    const shortLog = logLines.slice(-60).join('\n')
    res.status(500).json({ error: err.message, log: shortLog })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const PORT = 3001
app.listen(PORT, () => console.log(`ResuForge backend running on http://localhost:${PORT}`))
