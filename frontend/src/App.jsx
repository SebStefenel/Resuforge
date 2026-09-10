import { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect } from 'react'
import LatexEditor from './components/LatexEditor'
import PdfViewer from './components/PdfViewer'
import VariantPanel from './components/VariantPanel'
import CreateSlotModal from './components/CreateSlotModal'
import ResumeSwitcher from './components/ResumeSwitcher'
import { supabase } from './lib/supabaseClient'
import {
  listResumes, loadResume, createResume, deleteResume,
  saveResume, saveResumeOnUnload,
  readLocalBackup, writeLocalBackup, clearLocalBackup,
} from './lib/resumeStore'
import { authFetch, API_URL } from './lib/api'
import { attachResume } from './lib/wwStore'
import { buildResumeContext } from './lib/resumeContext'
import {
  normalizeCategories, normalizeCategory, resolveTemplate, combinationCount,
  enumerateSelections, comboFolder, resolveTemplateWithMap, mapResolvedLineToTemplate,
} from './lib/variants'
import { parseSynctex, lookupLine } from './lib/synctex'
import { jumpToOffset } from './components/LatexEditor'
import './App.css'

const LAYOUT_KEY = 'resuforge_layout'
// Which resume was open last, per user, so a reload reopens it rather than
// dumping you on whichever happens to sort first.
const lastResumeKey = (userId) => `resuforge_last_resume_${userId}`
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

// Restore the Variants panel's display order.
//
// The panel renders categories in object key order, but they come back from
// Postgres as jsonb, which normalizes object keys (sorted by length, then
// bytewise) rather than preserving insertion order. `category_order` is the
// saved order; rebuilding the object in that sequence is what makes a
// drag-and-drop rearrangement survive a reload. See migration 0003.
//
// Anything missing from the order list (older rows saved before this existed,
// or a category added by another tab) keeps its existing relative position at
// the end, so nothing is ever dropped.
function applyCategoryOrder(categories, order) {
  if (!Array.isArray(order) || order.length === 0) return categories
  const out = {}
  for (const name of order) {
    if (Object.prototype.hasOwnProperty.call(categories, name)) out[name] = categories[name]
  }
  for (const name of Object.keys(categories)) {
    if (!(name in out)) out[name] = categories[name]
  }
  return out
}

export default function App({ user, nav }) {
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)

  // ── Multiple resumes ──────────────────────────────────────────────
  // `resumes` is the switcher list (names only); `currentId` selects which
  // document the editor below is bound to. Everything that used to key off
  // user.id now keys off currentId.
  const [resumes, setResumes] = useState([])
  const [currentId, setCurrentId] = useState(null)
  // True while creating/duplicating/deleting/switching. Blocks the switcher so
  // an in-flight save can't land against the wrong document.
  const [switching, setSwitching] = useState(false)

  // 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' — surfaced in the topbar.
  // Declared up here because the load effect below reports 'saved' once the
  // document is in sync. Without a visible indicator a failing save looks
  // identical to a working one until you reopen the tab and find work missing.
  const [saveState, setSaveState] = useState('idle')
  const [saveError, setSaveError] = useState(null)

  const [template, setTemplate] = useState(DEFAULT_TEMPLATE)
  // Normalized on load so old saves (preset = plain string) upgrade to the
  // richer { latex, tags } shape and every category has a type. See lib/variants.js.
  const [categories, setCategories] = useState({})
  const [selected, setSelected] = useState({})
  // { categoryName: presetName (single) | [presetNames] (multi) }

  const [pdfUrl, setPdfUrl] = useState(null)
  // { synctex, resolved } captured at compile time — powers click-to-source.
  const [syncData, setSyncData] = useState(null)
  const [syncNote, setSyncNote] = useState(null)
  const [compiling, setCompiling] = useState(false)
  const [zipping, setZipping] = useState(false)
  const [compileError, setCompileError] = useState(null)

  // Base name used for downloaded files (without extension).
  const [resumeName, setResumeName] = useState('resume')

  // Saving is DISABLED until a load definitively succeeds. Without this gate a
  // failed load leaves state at the defaults, the debounced save fires, and the
  // blank template is written straight over the user's real document. The JSX
  // error screen does not prevent this — effects run regardless of what renders.
  const canSave = useRef(false)
  // Declared alongside the other save guards because the resume-load effect
  // below resets them together on every switch.
  const dirty = useRef(false) // unsaved changes outstanding?
  const saveTimer = useRef(null)
  // Serialized snapshot of what's currently in the database, so we only write
  // when the document has genuinely changed. This is the second half of the
  // guard: it stops the save that would otherwise fire the instant `loaded`
  // flips true, before the user has touched anything.
  const persistedDoc = useRef(null)

  const serializeDoc = (d) =>
    JSON.stringify([d.resumeName, d.template, d.categories, d.selected])

  // Does this document contain real work? Used both to decide what's worth
  // mirroring locally and to spot a server document that looks suspiciously
  // empty — the signature of the overwrite bug this guards against.
  const hasContent = (d) => {
    const tpl = (d.template ?? '').trim()
    const editedTemplate = tpl !== '' && tpl !== DEFAULT_TEMPLATE.trim()
    const hasSlots = Object.keys(d.categories ?? {}).length > 0
    return editedTemplate || hasSlots
  }

  // Offer to restore the local mirror when the server copy came back empty.
  const [restoreOffer, setRestoreOffer] = useState(null)

  // Backend rejected our token even after a forced refresh.
  const [sessionExpired, setSessionExpired] = useState(false)

  // Bootstrap: fetch the resume list and decide which one to open. A brand-new
  // account gets one created for it, so the editor is always bound to a real
  // row and `currentId` is never null once loading finishes.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let list = await listResumes(user.id)
        if (list.length === 0) {
          const created = await createResume(user.id, {
            resumeName: 'resume',
            template: DEFAULT_TEMPLATE,
            categories: {},
            selected: {},
          })
          list = [created]
        }
        if (cancelled) return
        let pick = null
        try { pick = localStorage.getItem(lastResumeKey(user.id)) } catch {}
        if (!list.some((r) => r.id === pick)) pick = list[0].id
        setResumes(list)
        setCurrentId(pick)
      } catch (err) {
        if (cancelled) return
        // Leave canSave false so nothing is written against an unknown document.
        setLoadError(err.message)
        setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [user.id])

  // Load whichever resume is selected. Re-runs on every switch, resetting the
  // save guards first so a pending write from the previous document can never
  // land on the new one.
  useEffect(() => {
    if (!currentId) return
    let cancelled = false
    canSave.current = false
    persistedDoc.current = null
    dirty.current = false
    setLoaded(false)
    setRestoreOffer(null)
    try { localStorage.setItem(lastResumeKey(user.id), currentId) } catch {}

    loadResume(currentId)
      .then((row) => {
        if (cancelled) return
        const doc = row
          ? {
              resumeName: row.resume_name || 'resume',
              template: row.template || DEFAULT_TEMPLATE,
              categories: applyCategoryOrder(
                normalizeCategories(row.categories ?? {}),
                row.category_order
              ),
              selected: row.selected ?? {},
            }
          // No row yet: a genuinely new account. Nothing is written until the
          // user actually edits something, so a spurious empty result can't
          // clobber an existing document.
          : { resumeName: 'resume', template: DEFAULT_TEMPLATE, categories: {}, selected: {} }

        // Always apply, even for a missing row: switching resumes must replace
        // what's on screen rather than leaving the previous document visible.
        setTemplate(doc.template)
        setCategories(doc.categories)
        setSelected(doc.selected)
        setResumeName(doc.resumeName)
        persistedDoc.current = serializeDoc(doc)
        canSave.current = true

        // Server copy is empty but this browser remembers real work: surface it
        // rather than letting the user discover the loss on their own. Nothing
        // is written until they choose — saving only fires on a real change.
        if (!hasContent(doc)) {
          const backup = readLocalBackup(currentId)
          if (backup && hasContent(backup)) setRestoreOffer(backup)
        }

        // What's on screen matches the database, so report that rather than
        // showing nothing. Saves now only fire on a real change, so without
        // this the indicator would stay blank until the first edit — leaving
        // no visible confirmation that persistence is working at all.
        setSaveState('saved')
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        // Leave canSave false: better to show an error and save nothing than to
        // overwrite good data with defaults we never managed to replace.
        setLoadError(err.message)
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [currentId, user.id])

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

  // Latest document in a ref, so the unload handler always writes current
  // values rather than whatever was captured when it was registered.
  const latestDoc = useRef(null)
  latestDoc.current = { resumeName, template, categories, selected }

  // Same idea for the open resume: the unload handler runs synchronously and
  // doSave needs to know whether we're still on the document it saved.
  const currentIdRef = useRef(null)
  currentIdRef.current = currentId

  const doSave = useCallback(async () => {
    if (!dirty.current || !canSave.current || !currentId) return
    dirty.current = false
    const snapshot = serializeDoc(latestDoc.current)
    // Pin the target: an await'd save must land on the document it started
    // for, even if the user switches resumes mid-flight.
    const targetId = currentId
    setSaveState('saving')
    try {
      await saveResume(targetId, user.id, latestDoc.current)
      // Only claim "in sync" if we're still on the same document.
      if (currentIdRef.current === targetId) persistedDoc.current = snapshot
      // Mirror only real content, so an empty document can never overwrite a
      // good backup.
      if (hasContent(latestDoc.current)) writeLocalBackup(targetId, latestDoc.current)
      // Keep the switcher's name column in step with the filename field.
      setResumes((rs) => rs.map((r) =>
        r.id === targetId ? { ...r, resume_name: latestDoc.current.resumeName } : r
      ))
      setSaveState('saved')
      setSaveError(null)
    } catch (err) {
      dirty.current = true // stay dirty so the next change retries
      setSaveState('error')
      setSaveError(err.message || String(err))
    }
  }, [user.id, currentId])

  // Debounced save. Skipped until the initial load completes so we never
  // overwrite the stored row with defaults.
  useEffect(() => {
    if (!loaded || !canSave.current) return
    // Only write when the document actually differs from what's stored. This
    // is what stops a save firing on the load transition itself, which is how
    // default state could reach the database.
    if (serializeDoc({ resumeName, template, categories, selected }) === persistedDoc.current) return

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
      if (!dirty.current || !canSave.current) return
      clearTimeout(saveTimer.current)
      const token = sessionToken.current
      if (saveResumeOnUnload(currentIdRef.current, user.id, latestDoc.current, token)) {
        dirty.current = false
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [loaded, doSave, user.id])

  // Switching to the WaterlooWorks section unmounts the editor (see Shell.jsx),
  // which drops a debounced save that hasn't fired yet. Neither handler above
  // catches that: the tab stays visible and the page never unloads. A ref holds
  // the current doSave so this effect can run once and still call the live one.
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave
  useEffect(() => () => {
    clearTimeout(saveTimer.current)
    if (dirty.current && canSave.current) doSaveRef.current()
  }, [])

  // Hand the resume to the WaterlooWorks section as context for its AI screens.
  // A snapshot of the resolved document, not a live link: a shortlist should stay
  // explainable against the resume it was actually judged on, rather than being
  // silently reinterpreted every time this editor changes.
  const [sentToWW, setSentToWW] = useState(null)
  const handleSendToWW = useCallback(async () => {
    const ctx = buildResumeContext({
      resumeName, template, categories, selected, resumeId: currentId,
    })
    if (!ctx.text.trim()) {
      setSentToWW('empty')
      return
    }
    const ok = await attachResume(user.id, ctx)
    setSentToWW(ok ? 'ok' : 'fail')
    if (ok) window.location.hash = '#/ww'
  }, [resumeName, template, categories, selected, currentId, user.id])

  useEffect(() => {
    if (!sentToWW) return
    const t = setTimeout(() => setSentToWW(null), 4000)
    return () => clearTimeout(t)
  }, [sentToWW])

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

  // The resolved document from the most recent compile, kept so click-to-source
  // maps against exactly what produced the PDF on screen.
  const resolvedRef = useRef(null)

  const handleCompile = useCallback(async () => {
    setCompiling(true)
    setCompileError(null)
    try {
      const resolved = resolveTemplateWithMap(template, categories, selected)
      resolvedRef.current = resolved
      const latex = resolved.text

      // fetch() only rejects when the request never got a response (backend
      // down, connection reset). Catch that separately so we can point the
      // user at the backend instead of showing a cryptic parse error.
      let res
      try {
        res = await authFetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Opts into the JSON response carrying the SyncTeX map; without this
          // the server returns raw PDF bytes (see server.js).
          body: JSON.stringify({ latex, synctex: true })
        })
      } catch (e) {
        setCompileError(
          `Could not reach the compile server${API_URL ? ` at ${API_URL}` : ' at http://localhost:3001'}.\n\n` +
          `The backend isn't running (or crashed)${API_URL ? '' : '. Start it with start.ps1, or run "node server.js" in the backend folder'}, then Recompile.\n\n` +
          `Details: ${e.message}`
        )
        return
      }

      // Success. Accepts either response shape so a backend that predates the
      // SyncTeX change still works — it just won't support click-to-source.
      if (res.ok) {
        const contentType = res.headers.get('content-type') || ''
        let blob
        let synctex = null

        if (contentType.includes('application/json')) {
          const body = await res.json()
          const bytes = Uint8Array.from(atob(body.pdf), c => c.charCodeAt(0))
          blob = new Blob([bytes], { type: 'application/pdf' })
          synctex = parseSynctex(body.synctex)
        } else {
          blob = await res.blob()
        }

        const url = URL.createObjectURL(blob)
        setPdfUrl(prev => {
          if (prev) URL.revokeObjectURL(prev)
          return url
        })
        // Remember the exact document this PDF came from: click-to-source has
        // to map against what was compiled, not what's since been edited.
        setSyncData({ synctex, resolved: resolvedRef.current })
        return
      }

      // Still unauthorised after authFetch already refreshed and retried, so
      // the session is genuinely dead. This is not a LaTeX problem and must not
      // be reported as one.
      if (res.status === 401) {
        setSessionExpired(true)
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
  }, [template, categories, selected])

  // Pull the local mirror back into the editor. Loading it into state is enough
  // to make it real: the normal change-detected save then writes it back.
  const handleRestoreBackup = useCallback(() => {
    if (!restoreOffer) return
    setTemplate(restoreOffer.template ?? DEFAULT_TEMPLATE)
    setCategories(normalizeCategories(restoreOffer.categories ?? {}))
    setSelected(restoreOffer.selected ?? {})
    setResumeName(restoreOffer.resumeName || 'resume')
    setRestoreOffer(null)
  }, [restoreOffer])

  // Click in the PDF -> SyncTeX line in the compiled document -> position in
  // the template -> jump the editor there.
  const handleSyncClick = useCallback((page, x, y) => {
    setSyncNote(null)
    const data = syncData
    if (!data?.synctex || !data.resolved) return

    const line = lookupLine(data.synctex, page, x, y)
    if (line == null) {
      setSyncNote('No source found for that spot')
      return
    }

    const target = mapResolvedLineToTemplate(data.resolved, line)
    if (!target) {
      setSyncNote('No source found for that spot')
      return
    }

    jumpToOffset(editorRef.current, target.offset)
    // Injected variant text has no template position of its own, so say where
    // we actually landed rather than leaving it looking like a mis-jump.
    setSyncNote(
      target.category
        ? `From variant "${target.category}" — jumped to its slot`
        : null
    )
  }, [syncData])

  // Auto-dismiss the sync hint.
  useEffect(() => {
    if (!syncNote) return
    const t = setTimeout(() => setSyncNote(null), 3500)
    return () => clearTimeout(t)
  }, [syncNote])

  // ── Resume management ─────────────────────────────────────────────
  // Every one of these flushes pending edits first: the debounce means up to
  // 800ms of work is memory-only, and switching or deleting would otherwise
  // drop it.
  const flushPending = useCallback(async () => {
    clearTimeout(saveTimer.current)
    if (dirty.current && canSave.current) await doSave()
  }, [doSave])

  const handleSwitchResume = useCallback(async (id) => {
    if (id === currentId || switching) return
    setSwitching(true)
    try {
      await flushPending()
      setCurrentId(id) // the load effect does the rest
    } finally {
      setSwitching(false)
    }
  }, [currentId, switching, flushPending])

  const handleCreateResume = useCallback(async () => {
    setSwitching(true)
    try {
      await flushPending()
      const created = await createResume(user.id, {
        resumeName: 'Untitled resume',
        template: DEFAULT_TEMPLATE,
        categories: {},
        selected: {},
      })
      setResumes((rs) => [created, ...rs])
      setCurrentId(created.id)
    } catch (err) {
      setSaveState('error')
      setSaveError(`Couldn't create resume: ${err.message || err}`)
    } finally {
      setSwitching(false)
    }
  }, [user.id, flushPending])

  // Duplicating the OPEN resume uses what's on screen (post-flush, that's also
  // what's stored). Duplicating any other one reads it from the database.
  const handleDuplicateResume = useCallback(async (id) => {
    setSwitching(true)
    try {
      await flushPending()
      const source = id === currentId
        ? latestDoc.current
        : await loadResume(id).then((row) => row && {
            resumeName: row.resume_name || 'resume',
            template: row.template || DEFAULT_TEMPLATE,
            categories: normalizeCategories(row.categories ?? {}),
            selected: row.selected ?? {},
          })
      if (!source) throw new Error('That resume no longer exists')

      const created = await createResume(user.id, {
        ...source,
        resumeName: `${source.resumeName || 'resume'} copy`,
      })
      setResumes((rs) => [created, ...rs])
      setCurrentId(created.id)
    } catch (err) {
      setSaveState('error')
      setSaveError(`Couldn't duplicate resume: ${err.message || err}`)
    } finally {
      setSwitching(false)
    }
  }, [user.id, currentId, flushPending])

  const handleDeleteResume = useCallback(async (id) => {
    if (resumes.length <= 1) return // never leave the account with none
    setSwitching(true)
    try {
      // Deleting the open document: drop pending edits rather than letting the
      // debounce resurrect the row we're about to remove.
      if (id === currentId) {
        clearTimeout(saveTimer.current)
        dirty.current = false
        canSave.current = false
      } else {
        await flushPending()
      }

      await deleteResume(id)
      clearLocalBackup(id)
      const remaining = resumes.filter((r) => r.id !== id)
      setResumes(remaining)
      if (id === currentId) setCurrentId(remaining[0].id)
    } catch (err) {
      canSave.current = true // deletion failed; let saving resume
      setSaveState('error')
      setSaveError(`Couldn't delete resume: ${err.message || err}`)
    } finally {
      setSwitching(false)
    }
  }, [resumes, currentId, flushPending])

  // ── Copy resolved LaTeX ───────────────────────────────────────────
  // The exact document that would be compiled right now: every {{slot}}
  // replaced using the currently selected presets.
  const [copied, setCopied] = useState(null) // 'ok' | 'fail'
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(t)
  }, [copied])

  const handleCopyLatex = useCallback(async () => {
    const latex = resolveTemplate(template, categories, selected)
    try {
      await navigator.clipboard.writeText(latex)
      setCopied('ok')
    } catch {
      // Clipboard API needs a secure context and can be blocked by permissions;
      // fall back to a hidden textarea + execCommand.
      try {
        const ta = document.createElement('textarea')
        ta.value = latex
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        setCopied(ok ? 'ok' : 'fail')
      } catch {
        setCopied('fail')
      }
    }
  }, [template, categories, selected])

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

      if (res.status === 401) {
        setSessionExpired(true)
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
        <p><strong>Couldn't load your resume.</strong></p>
        <p className="app-loading-detail">{loadError}</p>
        <p className="app-loading-detail">
          Saving is disabled so your stored work isn't overwritten. Reload to try again —
          nothing has been changed.
        </p>
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
          {nav}
          <ResumeSwitcher
            resumes={resumes}
            currentId={currentId}
            busy={switching}
            onSwitch={handleSwitchResume}
            onCreate={handleCreateResume}
            onDuplicate={handleDuplicateResume}
            onDelete={handleDeleteResume}
          />
          <label className="filename-field" title="Resume name — also used for downloaded files">
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
            onClick={handleSendToWW}
            title="Attach this resume to the WaterlooWorks section, so AI screens can judge postings against it"
          >
            {sentToWW === 'ok' ? 'Sent!'
              : sentToWW === 'empty' ? 'Resume is empty'
              : sentToWW === 'fail' ? 'Send failed'
              : 'Send resume to WW'}
          </button>
          <button
            className="btn-ghost"
            onClick={handleCopyLatex}
            title="Copy the full LaTeX source, with the selected presets filled in"
          >
            {copied === 'ok' ? 'Copied!' : copied === 'fail' ? 'Copy failed' : 'Copy LaTeX'}
          </button>
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

      {restoreOffer && (
        <div className="restore-banner">
          <span>
            Your saved resume came back empty, but this browser has a backup from{' '}
            <strong>{new Date(restoreOffer.savedAt).toLocaleString()}</strong>.
          </span>
          <button className="btn-primary" onClick={handleRestoreBackup}>
            Restore it
          </button>
          <button className="btn-ghost" onClick={() => setRestoreOffer(null)}>
            Dismiss
          </button>
          <button
            className="restore-discard"
            onClick={() => { clearLocalBackup(currentId); setRestoreOffer(null) }}
            title="Delete this browser's backup copy"
          >
            Discard backup
          </button>
        </div>
      )}

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
          <div className="panel-header">
            Preview
            {syncNote && <span className="sync-note">{syncNote}</span>}
          </div>
          {sessionExpired
            ? <SessionExpired onSignOut={() => supabase.auth.signOut()} />
            : compileError
            ? <ErrorLog log={compileError} />
            : <PdfViewer
                url={pdfUrl}
                onSyncClick={syncData?.synctex ? handleSyncClick : undefined}
              />
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

// Shown when the compile backend rejects our token even after a forced
// refresh. Deliberately separate from ErrorLog: labelling this "Compilation
// Error" sends you hunting through LaTeX for a problem that isn't there.
function SessionExpired({ onSignOut }) {
  return (
    <div className="error-log">
      <div className="error-log-title">Session expired</div>
      <div className="session-expired-body">
        <p>
          Your sign-in expired, so the compile server turned the request away.
          Nothing is wrong with your LaTeX.
        </p>
        <p>
          <strong>Your work is safe</strong> — it's saved and will still be here
          after you sign back in.
        </p>
        <button className="btn-primary" onClick={onSignOut}>Sign in again</button>
      </div>
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
