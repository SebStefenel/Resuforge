import { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect } from 'react'
import LatexEditor from './components/LatexEditor'
import PdfViewer from './components/PdfViewer'
import VariantPanel from './components/VariantPanel'
import CreateSlotModal from './components/CreateSlotModal'
import './App.css'

const STORAGE_KEY = 'resuforge_state'
const LAYOUT_KEY = 'resuforge_layout'
const NAME_KEY = 'resuforge_name'
const MIN_PANEL = 220 // px — smallest a draggable panel may get
const GUTTER = 6 // px — width of each divider

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

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}

function saveLayout(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
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
  const [zipping, setZipping] = useState(false)
  const [compileError, setCompileError] = useState(null)

  // Base name used for downloaded files (without extension).
  const [resumeName, setResumeName] = useState(() => {
    try { return localStorage.getItem(NAME_KEY) || 'resume' } catch { return 'resume' }
  })
  useEffect(() => {
    try { localStorage.setItem(NAME_KEY, resumeName) } catch {}
  }, [resumeName])

  // Filesystem-safe base name, falling back to "resume" when empty.
  const safeName = useMemo(
    () => (resumeName.trim() || 'resume').replace(/[\\/:*?"<>|]+/g, '_'),
    [resumeName]
  )

  // "Download All" dropdown (nested vs flat layout).
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false)
  const downloadMenuRef = useRef(null)
  useEffect(() => {
    if (!downloadMenuOpen) return
    const onDown = (e) => {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target)) {
        setDownloadMenuOpen(false)
      }
    }
    const onEsc = (e) => { if (e.key === 'Escape') setDownloadMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [downloadMenuOpen])

  // For the "create slot" modal
  const [slotModal, setSlotModal] = useState(null)
  // { selectedText, from, to }

  const editorRef = useRef(null)

  // ── Resizable panels ──────────────────────────────────────────────
  const savedLayout = loadLayout()
  const [editorW, setEditorW] = useState(savedLayout?.editorW ?? null)
  const [previewW, setPreviewW] = useState(savedLayout?.previewW ?? null)
  const [dragging, setDragging] = useState(null) // 'editor' | 'preview' | null
  const panelsRef = useRef(null)

  // Initialise widths on first mount (before paint) if not restored from storage.
  useLayoutEffect(() => {
    if (editorW != null && previewW != null) return
    const el = panelsRef.current
    if (!el) return
    const total = el.clientWidth
    const variants = 320
    const each = Math.max(MIN_PANEL, Math.floor((total - variants - 2 * GUTTER) / 2))
    setEditorW(each)
    setPreviewW(each)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist widths whenever they change.
  useEffect(() => {
    if (editorW != null && previewW != null) saveLayout({ editorW, previewW })
  }, [editorW, previewW])

  // Keep panels from overflowing when the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const el = panelsRef.current
      if (!el || editorW == null || previewW == null) return
      const total = el.clientWidth
      const maxCombined = total - 2 * GUTTER - MIN_PANEL
      if (editorW + previewW > maxCombined && editorW + previewW > 0) {
        const scale = maxCombined / (editorW + previewW)
        setEditorW(Math.max(MIN_PANEL * 0.5, Math.floor(editorW * scale)))
        setPreviewW(Math.max(MIN_PANEL * 0.5, Math.floor(previewW * scale)))
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [editorW, previewW])

  const startDrag = useCallback((which) => (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startEditor = editorW
    const startPreview = previewW
    const total = panelsRef.current ? panelsRef.current.clientWidth : 0

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      if (which === 'editor') {
        // Dragging divider 1 resizes the editor; preview keeps its width.
        const maxEditor = total - 2 * GUTTER - startPreview - MIN_PANEL
        setEditorW(Math.max(MIN_PANEL, Math.min(startEditor + dx, maxEditor)))
      } else {
        // Dragging divider 2 resizes the preview; editor keeps its width.
        const maxPreview = total - 2 * GUTTER - startEditor - MIN_PANEL
        setPreviewW(Math.max(MIN_PANEL, Math.min(startPreview + dx, maxPreview)))
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setDragging(which)
  }, [editorW, previewW])

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

  const handleDownloadPdf = useCallback(() => {
    if (!pdfUrl) return
    const a = document.createElement('a')
    a.href = pdfUrl
    a.download = `${safeName}.pdf`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [pdfUrl, safeName])

  // Number of distinct resumes "Download All" will produce: the product of
  // preset counts across categories whose placeholder is actually in the
  // template (those are the ones that change the output).
  const comboCount = useMemo(() => {
    const varying = Object.keys(categories).filter(c =>
      categories[c]?.presets &&
      Object.keys(categories[c].presets).length > 0 &&
      template.includes(`{{${c}}}`)
    )
    if (varying.length === 0) return 0
    return varying.reduce((n, c) => n * Object.keys(categories[c].presets).length, 1)
  }, [categories, template])

  const handleDownloadAll = useCallback(async (layout = 'nested') => {
    setZipping(true)
    setCompileError(null)
    try {
      let res
      try {
        res = await fetch('/api/compile-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template, categories, filename: safeName, layout })
        })
      } catch (e) {
        setCompileError(
          `Could not reach the compile server at http://localhost:3001.\n\n` +
          `The backend isn't running (or crashed). Start it with start.ps1, ` +
          `then try again.\n\nDetails: ${e.message}`
        )
        return
      }

      const contentType = res.headers.get('content-type') || ''
      if (res.ok && contentType.includes('application/zip')) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${safeName}.zip`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        return
      }

      // Error path — surface a useful message.
      const text = await res.text()
      if (!text.trim()) {
        setCompileError(
          `The compile server returned an empty response (HTTP ${res.status}).\n\n` +
          `Check the backend terminal window for errors, then try again.`
        )
        return
      }
      try {
        const body = JSON.parse(text)
        setCompileError(body.log || body.error || `Download All failed (HTTP ${res.status})`)
      } catch {
        setCompileError(text)
      }
    } finally {
      setZipping(false)
    }
  }, [template, categories, safeName])

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo">ResuForge</span>
          <label className="filename-field" title="Name used for downloaded files">
            <input
              className="filename-input"
              value={resumeName}
              onChange={(e) => setResumeName(e.target.value)}
              placeholder="resume"
              spellCheck={false}
              aria-label="Resume file name"
            />
            <span className="filename-ext">.pdf</span>
          </label>
        </div>
        <div className="topbar-actions">
          <button className="btn-ghost" onClick={handleLoadFile}>Load .tex</button>
          <button
            className="btn-ghost"
            onClick={handleDownloadPdf}
            disabled={!pdfUrl}
            title={pdfUrl ? 'Download the compiled PDF' : 'Compile first to enable download'}
          >
            Download PDF
          </button>
          <div className="dropdown" ref={downloadMenuRef}>
            <button
              className="btn-ghost dropdown-toggle"
              onClick={() => setDownloadMenuOpen(o => !o)}
              disabled={zipping || compiling || comboCount === 0}
              title={
                comboCount === 0
                  ? 'Add variant categories used in the template to enable this'
                  : `Compile all ${comboCount} combination${comboCount === 1 ? '' : 's'} and download as a ZIP`
              }
            >
              {zipping ? 'Zipping…' : `Download All${comboCount > 0 ? ` (${comboCount})` : ''}`}
              <span className="dropdown-caret">▾</span>
            </button>
            {downloadMenuOpen && (
              <div className="dropdown-menu">
                <button
                  className="dropdown-item"
                  onClick={() => { setDownloadMenuOpen(false); handleDownloadAll('nested') }}
                >
                  <span className="dropdown-item-title">Nested folders</span>
                  <span className="dropdown-item-sub">resumes/location:toronto/email:school/…</span>
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => { setDownloadMenuOpen(false); handleDownloadAll('flat') }}
                >
                  <span className="dropdown-item-title">One folder (flat)</span>
                  <span className="dropdown-item-sub">resumes/location:toronto__email:school/…</span>
                </button>
              </div>
            )}
          </div>
          <button
            className="btn-primary compile-btn"
            onClick={handleCompile}
            disabled={compiling || zipping}
          >
            {compiling ? 'Compiling…' : 'Recompile'}
          </button>
        </div>
      </header>

      <div className="panels" ref={panelsRef}>
        <div
          className="panel panel-editor"
          style={editorW != null ? { width: editorW } : undefined}
        >
          <div className="panel-header">LaTeX</div>
          <LatexEditor
            ref={editorRef}
            value={template}
            onChange={handleTemplateChange}
            onRequestCreateSlot={handleRequestCreateSlot}
            categories={categories}
          />
        </div>

        <div
          className={`gutter${dragging === 'editor' ? ' gutter--dragging' : ''}`}
          onMouseDown={startDrag('editor')}
          title="Drag to resize"
        />

        <div
          className="panel panel-preview"
          style={previewW != null ? { width: previewW } : undefined}
        >
          <div className="panel-header">Preview</div>
          {compileError
            ? <ErrorLog log={compileError} />
            : <PdfViewer url={pdfUrl} />
          }
        </div>

        <div
          className={`gutter${dragging === 'preview' ? ' gutter--dragging' : ''}`}
          onMouseDown={startDrag('preview')}
          title="Drag to resize"
        />

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
