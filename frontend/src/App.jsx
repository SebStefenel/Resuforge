import { useState, useCallback, useRef } from 'react'
import LatexEditor from './components/LatexEditor'
import PdfViewer from './components/PdfViewer'
import VariantPanel from './components/VariantPanel'
import CreateSlotModal from './components/CreateSlotModal'
import './App.css'

const STORAGE_KEY = 'resuforge_state'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {}
}

const DEFAULT_TEMPLATE = `% Welcome to ResuForge!
% Highlight any text in this editor, then click "Create Slot"
% to turn it into a swappable variant.

\\documentclass[11pt]{article}
\\begin{document}

Hello, World!

\\end{document}
`

export default function App() {
  const saved = loadState()

  const [template, setTemplate] = useState(saved?.template ?? DEFAULT_TEMPLATE)
  const [categories, setCategories] = useState(saved?.categories ?? {})
  // { categoryName: { presets: { presetName: value }, description: '' } }
  const [selected, setSelected] = useState(saved?.selected ?? {})
  // { categoryName: presetName }

  const [pdfUrl, setPdfUrl] = useState(null)
  const [compiling, setCompiling] = useState(false)
  const [compileError, setCompileError] = useState(null)

  // For the "create slot" modal
  const [slotModal, setSlotModal] = useState(null)
  // { selectedText, from, to }

  const editorRef = useRef(null)

  // Persist on every meaningful change
  const persist = useCallback((t, c, s) => {
    saveState({ template: t, categories: c, selected: s })
  }, [])

  const handleTemplateChange = useCallback((val) => {
    setTemplate(val)
    persist(val, categories, selected)
  }, [categories, selected, persist])

  // Called by editor when user has text selected and clicks Create Slot
  const handleRequestCreateSlot = useCallback((selectedText, from, to) => {
    setSlotModal({ selectedText, from, to })
  }, [])

  const handleCreateSlot = useCallback(({ categoryName, presetName, value, from, to }) => {
    const newCategories = { ...categories }
    if (!newCategories[categoryName]) {
      newCategories[categoryName] = { presets: {} }
    }
    newCategories[categoryName] = {
      ...newCategories[categoryName],
      presets: {
        ...newCategories[categoryName].presets,
        [presetName]: value
      }
    }

    // Replace the selected range in the template with {{categoryName}}
    const placeholder = `{{${categoryName}}}`
    const newTemplate = template.slice(0, from) + placeholder + template.slice(to)

    const newSelected = { ...selected }
    if (!newSelected[categoryName]) {
      newSelected[categoryName] = presetName
    }

    setTemplate(newTemplate)
    setCategories(newCategories)
    setSelected(newSelected)
    persist(newTemplate, newCategories, newSelected)
    setSlotModal(null)
  }, [categories, selected, template, persist])

  const handleAddPreset = useCallback((categoryName, presetName, value) => {
    const newCategories = {
      ...categories,
      [categoryName]: {
        ...categories[categoryName],
        presets: {
          ...categories[categoryName].presets,
          [presetName]: value
        }
      }
    }
    setCategories(newCategories)
    persist(template, newCategories, selected)
  }, [categories, template, selected, persist])

  const handleDeletePreset = useCallback((categoryName, presetName) => {
    const newPresets = { ...categories[categoryName].presets }
    delete newPresets[presetName]
    const newCategories = {
      ...categories,
      [categoryName]: { ...categories[categoryName], presets: newPresets }
    }
    const newSelected = { ...selected }
    if (newSelected[categoryName] === presetName) {
      const remaining = Object.keys(newPresets)
      newSelected[categoryName] = remaining[0] ?? null
    }
    setCategories(newCategories)
    setSelected(newSelected)
    persist(template, newCategories, newSelected)
  }, [categories, template, selected, persist])

  const handleDeleteCategory = useCallback((categoryName) => {
    const newCategories = { ...categories }
    delete newCategories[categoryName]
    const newSelected = { ...selected }
    delete newSelected[categoryName]
    // Remove placeholder from template too
    const newTemplate = template.replaceAll(`{{${categoryName}}}`, '')
    setTemplate(newTemplate)
    setCategories(newCategories)
    setSelected(newSelected)
    persist(newTemplate, newCategories, newSelected)
  }, [categories, template, selected, persist])

  const handleSelectPreset = useCallback((categoryName, presetName) => {
    const newSelected = { ...selected, [categoryName]: presetName }
    setSelected(newSelected)
    persist(template, categories, newSelected)
  }, [selected, template, categories, persist])

  const handleRenamePreset = useCallback((categoryName, oldName, newName) => {
    if (oldName === newName || !newName.trim()) return
    const presets = { ...categories[categoryName].presets }
    const val = presets[oldName]
    delete presets[oldName]
    presets[newName] = val
    const newCategories = {
      ...categories,
      [categoryName]: { ...categories[categoryName], presets }
    }
    const newSelected = { ...selected }
    if (newSelected[categoryName] === oldName) newSelected[categoryName] = newName
    setCategories(newCategories)
    setSelected(newSelected)
    persist(template, newCategories, newSelected)
  }, [categories, selected, template, persist])

  const handleUpdatePresetValue = useCallback((categoryName, presetName, value) => {
    const newCategories = {
      ...categories,
      [categoryName]: {
        ...categories[categoryName],
        presets: { ...categories[categoryName].presets, [presetName]: value }
      }
    }
    setCategories(newCategories)
    persist(template, newCategories, selected)
  }, [categories, selected, template, persist])

  const resolvedLatex = useCallback(() => {
    let result = template
    for (const [cat, presetName] of Object.entries(selected)) {
      if (!presetName) continue
      const value = categories[cat]?.presets?.[presetName] ?? ''
      result = result.replaceAll(`{{${cat}}}`, value)
    }
    return result
  }, [template, categories, selected])

  const handleCompile = useCallback(async () => {
    setCompiling(true)
    setCompileError(null)
    try {
      const latex = resolvedLatex()

      // fetch() only rejects when the request never got a response (backend
      // down, connection reset). Catch that separately so we can point the
      // user at the backend instead of showing a cryptic parse error.
      let res
      try {
        res = await fetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latex })
        })
      } catch (e) {
        setCompileError(
          `Could not reach the compile server at http://localhost:3001.\n\n` +
          `The backend isn't running (or crashed). Start it with start.ps1, ` +
          `or run "node server.js" in the backend folder, then Recompile.\n\n` +
          `Details: ${e.message}`
        )
        return
      }

      const contentType = res.headers.get('content-type') || ''

      // Success: a PDF came back.
      if (res.ok && contentType.includes('application/pdf')) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        setPdfUrl(prev => {
          if (prev) URL.revokeObjectURL(prev)
          return url
        })
        return
      }

      // Error path: read the body as text first, then try to parse JSON.
      // An empty body here means the request was cut off (proxy/timeout/crash).
      const text = await res.text()
      if (!text.trim()) {
        setCompileError(
          `The compile server returned an empty response (HTTP ${res.status}).\n\n` +
          `This usually means the backend crashed or the request was interrupted ` +
          `mid-compile. Check the backend terminal window for errors, then Recompile.`
        )
        return
      }
      try {
        const body = JSON.parse(text)
        setCompileError(body.log || body.error || `Compilation failed (HTTP ${res.status})`)
      } catch {
        setCompileError(text)
      }
    } finally {
      setCompiling(false)
    }
  }, [resolvedLatex])

  const handleLoadFile = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.tex'
    input.onchange = (e) => {
      const file = e.target.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = (ev) => {
        const text = ev.target.result
        setTemplate(text)
        persist(text, categories, selected)
      }
      reader.readAsText(file)
    }
    input.click()
  }, [categories, selected, persist])

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">ResuForge</span>
        <div className="topbar-actions">
          <button className="btn-ghost" onClick={handleLoadFile}>Load .tex</button>
          <button
            className="btn-primary compile-btn"
            onClick={handleCompile}
            disabled={compiling}
          >
            {compiling ? 'Compiling…' : 'Recompile'}
          </button>
        </div>
      </header>

      <div className="panels">
        <div className="panel panel-editor">
          <div className="panel-header">LaTeX</div>
          <LatexEditor
            ref={editorRef}
            value={template}
            onChange={handleTemplateChange}
            onRequestCreateSlot={handleRequestCreateSlot}
            categories={categories}
          />
        </div>

        <div className="panel panel-preview">
          <div className="panel-header">Preview</div>
          {compileError
            ? <ErrorLog log={compileError} />
            : <PdfViewer url={pdfUrl} />
          }
        </div>

        <div className="panel panel-variants">
          <div className="panel-header">Variants</div>
          <VariantPanel
            categories={categories}
            selected={selected}
            onSelectPreset={handleSelectPreset}
            onAddPreset={handleAddPreset}
            onDeletePreset={handleDeletePreset}
            onDeleteCategory={handleDeleteCategory}
            onRenamePreset={handleRenamePreset}
            onUpdatePresetValue={handleUpdatePresetValue}
          />
        </div>
      </div>

      {slotModal && (
        <CreateSlotModal
          selectedText={slotModal.selectedText}
          from={slotModal.from}
          to={slotModal.to}
          existingCategories={Object.keys(categories)}
          onCreate={handleCreateSlot}
          onClose={() => setSlotModal(null)}
        />
      )}
    </div>
  )
}

function ErrorLog({ log }) {
  return (
    <div className="error-log">
      <div className="error-log-title">Compilation Error</div>
      <pre className="error-log-body">{log}</pre>
    </div>
  )
}
