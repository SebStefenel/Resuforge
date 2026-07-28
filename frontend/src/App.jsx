import { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect } from 'react'
import LatexEditor from './components/LatexEditor'
import PdfViewer from './components/PdfViewer'
import VariantPanel from './components/VariantPanel'
import CreateSlotModal from './components/CreateSlotModal'
import { supabase } from './lib/supabaseClient'
import { loadResume, saveResume, saveResumeOnUnload } from './lib/resumeStore'
import { authFetch, API_URL } from './lib/api'
import {
  normalizeCategories, normalizeCategory, resolveTemplate, combinationCount,
  enumerateSelections, comboFolder,
} from './lib/variants'
import './App.css'

const LAYOUT_KEY = 'resuforge_layout'
const MIN_PANEL = 220 // px — smallest a draggable panel may get
const GUTTER = 6 // px — width of each divider

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

export default function App({ user }) {
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)

  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  // Normalized on load so old saves (preset = plain string) upgrade to the
  // richer { latex, tags } shape and every category has a type. See lib/variants.js.
  const [categories, setCategories] = useState({})
  const [selected, setSelected] = useState({})
  // { categoryName: presetName (single) | [presetNames] (multi) }

  const [pdfUrl, setPdfUrl] = useState(null)
  const [compiling, setCompiling] = useState(false)
  const [zipping, setZipping] = useState(false)
  const [compileError, setCompileError] = useState(null)

  // Base name used for downloaded files (without extension).
  const [resumeName, setResumeName] = useState('resume')

  // Fetch this user's saved resume from Supabase once on mount.
  useEffect(() => {
    let cancelled = false
    loadResume(user.id)
      .then((row) => {
        if (cancelled) return
        if (row) {
          setTemplate(row.template || DEFAULT_TEMPLATE)
          setCategories(normalizeCategories(row.categories ?? {}))
          setSelected(row.selected ?? {})
          setResumeName(row.resume_name || 'resume')
        }
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err.message)
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [user.id])

  // Access token mirrored into a ref: the pagehide handler runs synchronously
  // and can't await supabase.auth.getSession().
  const sessionToken = useRef(null)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      sessionToken.current = data.session?.access_token ?? null
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      sessionToken.current = s?.access_token ?? null
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' — surfaced in the topbar.
  // Without this a failing save is completely invisible: you keep working and
  // only discover the loss after reopening the tab.
  const [saveState, setSaveState] = useState('idle')
  const [saveError, setSaveError] = useState(null)

  // Latest document in a ref, so the unload handler always writes current
  // values rather than whatever was captured when it was registered.
  const latestDoc = useRef(null)
  latestDoc.current = { resumeName, template, categories, selected }

  const dirty = useRef(false) // unsaved changes outstanding?
  const saveTimer = useRef(null)

  const doSave = useCallback(async () => {
    if (!dirty.current) return
    dirty.current = false
    setSaveState('saving')
    try {
      await saveResume(user.id, latestDoc.current)
      setSaveState('saved')
      setSaveError(null)
    } catch (err) {
      dirty.current = true // stay dirty so the next change retries
      setSaveState('error')
      setSaveError(err.message || String(err))
    }
  }, [user.id])

  // Debounced save. Skipped until the initial load completes so we never
  // overwrite the stored row with defaults.
  useEffect(() => {
    if (!loaded) return
    dirty.current = true
    setSaveState('unsaved')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(doSave, 800)
    return () => clearTimeout(saveTimer.current)
  }, [loaded, doSave, resumeName, template, categories, selected])

  // Flush pending work when the page is hidden or closing. The debounce means
  // up to 800ms of edits are otherwise still only in memory, and a closing tab
  // silently drops the pending timer — the likely cause of "my changes vanished".
  useEffect(() => {
    if (!loaded) return

    // Tab hidden (switched away, minimised, mobile backgrounding): the page is
    // still alive, so a normal save works and reports status properly.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && dirty.current) {
        clearTimeout(saveTimer.current)
        doSave()
      }
    }
    // Page actually going away: normal requests get killed, so use keepalive.
    const onPageHide = () => {
      if (!dirty.current) return
      clearTimeout(saveTimer.current)
      const token = sessionToken.current
      if (saveResumeOnUnload(user.id, latestDoc.current, token)) dirty.current = false
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [loaded, doSave, user.id])

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
  }, [loaded])

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

  const handleTemplateChange = useCallback((val) => {
    setTemplate(val)
  }, [])

  // Called by editor when user has text selected and clicks Create Slot
  const handleRequestCreateSlot = useCallback((selectedText, from, to) => {
    setSlotModal({ selectedText, from, to })
  }, [])

  // Commit a categories/selected change and persist in one place.
  const commit = useCallback((newCategories, newSelected = selected, newTemplate = template) => {
    setCategories(newCategories)
    setSelected(newSelected)
    if (newTemplate !== template) setTemplate(newTemplate)
  }, [selected, template])

  // Shallow-patch a single category.
  const patchCategory = useCallback((categoryName, patch, newSelected = selected) => {
    const newCategories = {
      ...categories,
      [categoryName]: { ...categories[categoryName], ...patch },
    }
    commit(newCategories, newSelected)
  }, [categories, selected, commit])

  const handleCreateSlot = useCallback(({ categoryName, presetName, value, from, to, type = 'single' }) => {
    const newCategories = { ...categories }
    const newSelected = { ...selected }

    if (type === 'derived') {
      newCategories[categoryName] = normalizeCategory({ type: 'derived' })
      // derived slots aren't "selected" — they're computed
      delete newSelected[categoryName]
    } else {
      const existing = newCategories[categoryName]
      const base = existing ?? normalizeCategory({ type })
      newCategories[categoryName] = {
        ...base,
        type: existing ? base.type : type,
        presets: { ...base.presets, [presetName]: { latex: value, tags: {} } },
      }
      if (newSelected[categoryName] == null) {
        newSelected[categoryName] = newCategories[categoryName].type === 'multi' ? [presetName] : presetName
      }
    }

    const newTemplate = template.slice(0, from) + `{{${categoryName}}}` + template.slice(to)
    commit(newCategories, newSelected, newTemplate)
    setSlotModal(null)
  }, [categories, selected, template, commit])

  const handleAddPreset = useCallback((categoryName, presetName, value) => {
    patchCategory(categoryName, {
      presets: { ...categories[categoryName].presets, [presetName]: { latex: value, tags: {} } },
    })
  }, [categories, patchCategory])

  const handleDeletePreset = useCallback((categoryName, presetName) => {
    const cat = categories[categoryName]
    const newPresets = { ...cat.presets }
    delete newPresets[presetName]
    const newSelected = { ...selected }
    if (cat.type === 'multi') {
      newSelected[categoryName] = (selected[categoryName] || []).filter(n => n !== presetName)
    } else if (selected[categoryName] === presetName) {
      newSelected[categoryName] = Object.keys(newPresets)[0] ?? null
    }
    commit({ ...categories, [categoryName]: { ...cat, presets: newPresets } }, newSelected)
  }, [categories, selected, commit])

  const handleDeleteCategory = useCallback((categoryName) => {
    const newCategories = { ...categories }
    delete newCategories[categoryName]
    // Drop this category from any derived slot's sources.
    for (const [name, cat] of Object.entries(newCategories)) {
      if (cat.type === 'derived' && cat.sources.includes(categoryName)) {
        newCategories[name] = { ...cat, sources: cat.sources.filter(s => s !== categoryName) }
      }
    }
    const newSelected = { ...selected }
    delete newSelected[categoryName]
    const newTemplate = template.split(`{{${categoryName}}}`).join('')
    commit(newCategories, newSelected, newTemplate)
  }, [categories, selected, template, commit])

  // Reorder categories (drag-and-drop in the Variants panel). Object key order
  // is the render order, so we rebuild the object in the requested order.
  const handleReorderCategories = useCallback((orderedNames) => {
    const next = {}
    for (const n of orderedNames) if (categories[n]) next[n] = categories[n]
    for (const n of Object.keys(categories)) if (!(n in next)) next[n] = categories[n]
    commit(next)
  }, [categories, commit])

  // Single-select.
  const handleSelectPreset = useCallback((categoryName, presetName) => {
    commit(categories, { ...selected, [categoryName]: presetName })
  }, [categories, selected, commit])

  // Multi-select toggle.
  const handleToggleMultiPick = useCallback((categoryName, presetName) => {
    const cur = Array.isArray(selected[categoryName]) ? selected[categoryName] : []
    const next = cur.includes(presetName) ? cur.filter(n => n !== presetName) : [...cur, presetName]
    commit(categories, { ...selected, [categoryName]: next })
  }, [categories, selected, commit])

  const handleRenamePreset = useCallback((categoryName, oldName, newName) => {
    if (oldName === newName || !newName.trim()) return
    const cat = categories[categoryName]
    if (cat.presets[newName]) return // don't clobber
    const presets = {}
    // preserve order
    for (const [k, v] of Object.entries(cat.presets)) presets[k === oldName ? newName : k] = v
    const newSelected = { ...selected }
    if (cat.type === 'multi') {
      newSelected[categoryName] = (selected[categoryName] || []).map(n => (n === oldName ? newName : n))
    } else if (selected[categoryName] === oldName) {
      newSelected[categoryName] = newName
    }
    commit({ ...categories, [categoryName]: { ...cat, presets } }, newSelected)
  }, [categories, selected, commit])

  const handleUpdatePresetValue = useCallback((categoryName, presetName, latex) => {
    const cat = categories[categoryName]
    patchCategory(categoryName, {
      presets: { ...cat.presets, [presetName]: { ...cat.presets[presetName], latex } },
    })
  }, [categories, patchCategory])

  // Toggle a single tag (group + term) on a preset.
  const handleTogglePresetTag = useCallback((categoryName, presetName, groupName, term) => {
    const cat = categories[categoryName]
    const preset = cat.presets[presetName]
    const cur = preset.tags[groupName] ?? []
    const nextTerms = cur.includes(term) ? cur.filter(t => t !== term) : [...cur, term]
    const tags = { ...preset.tags, [groupName]: nextTerms }
    patchCategory(categoryName, {
      presets: { ...cat.presets, [presetName]: { ...preset, tags } },
    })
  }, [categories, patchCategory])

  // Change a category's type, fixing up its selection.
  const handleSetCategoryType = useCallback((categoryName, type) => {
    const cat = categories[categoryName]
    const newSelected = { ...selected }
    if (type === 'multi') {
      const cur = selected[categoryName]
      newSelected[categoryName] = Array.isArray(cur) ? cur : (cur ? [cur] : [])
    } else if (type === 'single') {
      const cur = selected[categoryName]
      newSelected[categoryName] = Array.isArray(cur) ? (cur[0] ?? null) : cur ?? Object.keys(cat.presets)[0] ?? null
    } else {
      delete newSelected[categoryName] // derived
    }
    patchCategory(categoryName, { type }, newSelected)
  }, [categories, selected, patchCategory])

  // Patch a category's config fields (selectCount, separator, sources, itemTemplate, joiner).
  const handleSetCategoryConfig = useCallback((categoryName, patch) => {
    patchCategory(categoryName, patch)
  }, [patchCategory])

  const handleAddGroup = useCallback((categoryName, groupName) => {
    const name = groupName.trim()
    if (!name) return
    const cat = categories[categoryName]
    if (cat.groups.some(g => g.name === name)) return
    patchCategory(categoryName, { groups: [...cat.groups, { name, terms: [] }] })
  }, [categories, patchCategory])

  const handleRemoveGroup = useCallback((categoryName, groupName) => {
    const cat = categories[categoryName]
    const groups = cat.groups.filter(g => g.name !== groupName)
    // Also drop this group from every preset's tags.
    const presets = {}
    for (const [k, p] of Object.entries(cat.presets)) {
      const tags = { ...p.tags }; delete tags[groupName]
      presets[k] = { ...p, tags }
    }
    patchCategory(categoryName, { groups, presets })
  }, [categories, patchCategory])

  const handleAddTerm = useCallback((categoryName, groupName, term) => {
    const t = term.trim()
    if (!t) return
    const cat = categories[categoryName]
    const groups = cat.groups.map(g =>
      g.name === groupName && !g.terms.includes(t) ? { ...g, terms: [...g.terms, t] } : g
    )
    patchCategory(categoryName, { groups })
  }, [categories, patchCategory])

  const handleRemoveTerm = useCallback((categoryName, groupName, term) => {
    const cat = categories[categoryName]
    const groups = cat.groups.map(g =>
      g.name === groupName ? { ...g, terms: g.terms.filter(t => t !== term) } : g
    )
    // Remove the term from every preset that had it under this group.
    const presets = {}
    for (const [k, p] of Object.entries(cat.presets)) {
      if (p.tags[groupName]?.includes(term)) {
        presets[k] = { ...p, tags: { ...p.tags, [groupName]: p.tags[groupName].filter(t => t !== term) } }
      } else {
        presets[k] = p
      }
    }
    patchCategory(categoryName, { groups, presets })
  }, [categories, patchCategory])

  const resolvedLatex = useCallback(
    () => resolveTemplate(template, categories, selected),
    [template, categories, selected]
  )

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
        res = await authFetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latex })
        })
      } catch (e) {
        setCompileError(
          `Could not reach the compile server${API_URL ? ` at ${API_URL}` : ' at http://localhost:3001'}.\n\n` +
          `The backend isn't running (or crashed)${API_URL ? '' : '. Start it with start.ps1, or run "node server.js" in the backend folder'}, then Recompile.\n\n` +
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
        setTemplate(ev.target.result)
      }
      reader.readAsText(file)
    }
    input.click()
  }, [])

  const handleDownloadPdf = useCallback(() => {
    if (!pdfUrl) return
    const a = document.createElement('a')
    a.href = pdfUrl
    a.download = `${safeName}.pdf`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [pdfUrl, safeName])

  // Number of distinct resumes "Download All" will produce. Single slots
  // contribute their preset count; multi slots contribute C(n, selectCount);
  // derived slots are computed per combination and don't multiply the total.
  const comboCount = useMemo(
    () => combinationCount(template, categories),
    [categories, template]
  )

  const handleDownloadAll = useCallback(async (layout = 'nested') => {
    setZipping(true)
    setCompileError(null)
    try {
      // Resolve every combination up front (single source of truth in variants.js),
      // then hand the backend a flat list of documents + their zip paths.
      const jobs = enumerateSelections(template, categories).map(({ selection, parts }) => ({
        path: `${comboFolder(parts, layout)}/${safeName}.pdf`,
        latex: resolveTemplate(template, categories, selection),
      }))

      let res
      try {
        res = await authFetch('/api/compile-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobs })
        })
      } catch (e) {
        setCompileError(
          `Could not reach the compile server${API_URL ? ` at ${API_URL}` : ' at http://localhost:3001'}.\n\n` +
          `The backend isn't running (or crashed)${API_URL ? '' : '. Start it with start.ps1'}, then try again.\n\nDetails: ${e.message}`
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

  if (loadError) {
    return (
      <div className="app-loading">
        <p>Couldn't load your resume: {loadError}</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>Retry</button>
      </div>
    )
  }

  if (!loaded) {
    return <div className="app-loading">Loading your resume…</div>
  }

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
          <SaveStatus state={saveState} error={saveError} onRetry={doSave} />
          <span className="user-email" title={user.email}>{user.email}</span>
          <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
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
            onToggleMultiPick={handleToggleMultiPick}
            onAddPreset={handleAddPreset}
            onDeletePreset={handleDeletePreset}
            onDeleteCategory={handleDeleteCategory}
            onRenamePreset={handleRenamePreset}
            onUpdatePresetValue={handleUpdatePresetValue}
            onTogglePresetTag={handleTogglePresetTag}
            onSetCategoryType={handleSetCategoryType}
            onSetCategoryConfig={handleSetCategoryConfig}
            onAddGroup={handleAddGroup}
            onRemoveGroup={handleRemoveGroup}
            onAddTerm={handleAddTerm}
            onRemoveTerm={handleRemoveTerm}
            onReorderCategories={handleReorderCategories}
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

// Save state is otherwise invisible — a failing save looks identical to a
// working one until you reopen the tab and find your work gone.
function SaveStatus({ state, error, onRetry }) {
  if (state === 'idle') return null

  if (state === 'error') {
    return (
      <button
        className="save-status save-status--error"
        onClick={onRetry}
        title={`${error || 'Unknown error'}\n\nClick to retry.`}
      >
        ⚠ Not saved — retry
      </button>
    )
  }

  const label = { unsaved: 'Unsaved changes…', saving: 'Saving…', saved: 'Saved' }[state]
  return <span className={`save-status save-status--${state}`}>{label}</span>
}

function ErrorLog({ log }) {
  return (
    <div className="error-log">
      <div className="error-log-title">Compilation Error</div>
      <pre className="error-log-body">{log}</pre>
    </div>
  )
}
