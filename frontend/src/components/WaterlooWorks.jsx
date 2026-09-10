// The WaterlooWorks section: import scrapes, normalize them, screen them, export them.
//
// The scraper extension (WW-Scraper) collects postings into a JSON file and its
// "Export to ResuForge" button drops you here. Everything downstream of that
// file — the normalization that used to be `tools/clean.js`, the completeness
// report it printed, and the postings.clean.json / postings.csv it wrote —
// happens in this page. See lib/wwClean.js.
//
// Postings are organized into named batches over one shared pool (lib/batches.js).
// A batch comes from an import, from an AI screen that keeps only the postings
// matching a subjective question (lib/screen.js), or from removing rows by hand.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { loadWorkspace, saveWorkspace, clearWorkspace } from '../lib/wwStore'
import {
  emptyWorkspace, activeBatch, batchPostings, addImportBatch, deriveBatch,
  removeFromBatch, renameBatch, deleteBatch, setActive, updatePostings,
} from '../lib/batches'
import { hasAnyKey } from '../lib/ai'
import { normalizeAll, pendingCount, formatRange } from '../lib/compensation'
import { toCsv, toCleanJson, tally, filterPostings, sortPostings, EMPTY_FILTERS } from '../lib/wwClean'
import ScreenDialog from './ScreenDialog'
import './WaterlooWorks.css'

const PAGE = 200 // rows added per "show more" — full tables run to a few thousand

export default function WaterlooWorks({ user, nav, ai, onOpenAi }) {
  const [ws, setWs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null) // status line while parsing
  const [notice, setNotice] = useState(null) // { kind: 'error' | 'warn' | 'ok', text }
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [sort, setSort] = useState({ key: 'deadline', dir: 'asc' })
  const [selectedId, setSelectedId] = useState(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [dragging, setDragging] = useState(false)
  const [screening, setScreening] = useState(false)
  const fileInput = useRef(null)
  // Set while the file picker is open for "new batch from file" rather than
  // "import more", since one <input> serves both.
  const importAsNew = useRef(false)

  // Compensation normalization: { done, total, failed, note } while a run is in
  // flight, null otherwise. The AbortController is what the Stop button pulls.
  const [comp, setComp] = useState(null)
  const compAbort = useRef(null)

  // The workspace in a ref, so callbacks that run across awaits always persist
  // the latest one rather than whatever was captured when they were created.
  const wsRef = useRef(null)
  wsRef.current = ws

  const persist = useCallback(async (next) => {
    setWs(next)
    wsRef.current = next
    const ok = await saveWorkspace(user.id, next)
    if (!ok) setNotice({ kind: 'warn', text: "Couldn't save to this browser — changes are in memory only." })
    return ok
  }, [user.id])

  useEffect(() => {
    let cancelled = false
    loadWorkspace(user.id).then((w) => {
      if (cancelled) return
      if (w) { setWs(w); wsRef.current = w }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [user.id])

  const batch = ws ? activeBatch(ws) : null
  const postings = useMemo(
    () => (ws && batch ? batchPostings(ws, batch.id) : []),
    [ws, batch]
  )

  // ── import ────────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (fileList, { asNew = false } = {}) => {
    const files = [...(fileList || [])]
    if (!files.length) return

    setNotice(null)
    setBusy(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`)
    // Yield once so the status line paints before a multi-megabyte parse blocks
    // the thread.
    await new Promise((r) => setTimeout(r, 0))

    const docs = []
    const bad = []
    for (const file of files) {
      try {
        docs.push({ name: file.name, doc: JSON.parse(await file.text()) })
      } catch (err) {
        bad.push(`${file.name}: ${err.message}`)
      }
    }

    if (!docs.length) {
      setBusy(null)
      setNotice({ kind: 'error', text: `Nothing could be read.\n${bad.join('\n')}` })
      return
    }

    setBusy('Normalizing postings…')
    await new Promise((r) => setTimeout(r, 0))

    const base = wsRef.current || emptyWorkspace()
    const { ws: next, merged, batch: created } = addImportBatch(base, docs)
    setSelectedId(null)
    setLimit(PAGE)
    setBusy(null)
    await persist(next)

    const problems = [...bad, ...merged.skipped.map((s) => `${s.name}: ${s.reason}`)]
    const unpriced = merged.postings.filter((p) => !p.hourlyCad).length
    setNotice({
      kind: problems.length ? 'warn' : 'ok',
      text:
        `Imported ${merged.read} records into “${created.name}” — ${created.ids.length} postings, ` +
        `${merged.duplicates} duplicate id${merged.duplicates === 1 ? '' : 's'} collapsed.` +
        (unpriced ? `\n${unpriced} have no pay figure yet — use “Normalize pay” when you want it.` : '') +
        (problems.length ? '\n' + problems.join('\n') : ''),
    })
  }, [persist])

  const pickFiles = (asNew) => {
    importAsNew.current = asNew
    fileInput.current?.click()
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }
  const onDragOver = (e) => {
    e.preventDefault()
    setDragging(true)
  }
  // dragleave also fires when the pointer crosses from one child element to
  // another, which would flicker the highlight off mid-drag. Only treat it as a
  // leave when the pointer has actually left the section.
  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false)
  }

  // ── batches ───────────────────────────────────────────────────────────────
  const switchBatch = (id) => {
    setSelectedId(null)
    setLimit(PAGE)
    persist(setActive(wsRef.current, id))
  }

  const handleRename = () => {
    const name = prompt('Rename batch', batch.name)
    if (name) persist(renameBatch(wsRef.current, batch.id, name))
  }

  const handleDeleteBatch = () => {
    if (!confirm(`Delete the batch “${batch.name}”?\n\nPostings it shares with other batches are kept; any it alone held are removed.`)) return
    setSelectedId(null)
    persist(deleteBatch(wsRef.current, batch.id))
  }

  const handleRemove = (id) => {
    if (selectedId === id) setSelectedId(null)
    persist(removeFromBatch(wsRef.current, batch.id, [id]))
  }

  const handleClearAll = async () => {
    if (!confirm('Remove every batch and posting from this browser?')) return
    await clearWorkspace(user.id)
    setWs(null)
    wsRef.current = null
    setSelectedId(null)
    setFilters(EMPTY_FILTERS)
    setNotice(null)
  }

  // A screen produces a new batch over the postings it kept, carrying the
  // question and the per-posting reasons so the batch can explain itself later.
  const handleScreened = ({ name, ids, judgments, question, fields, stats }) => {
    const { ws: next, batch: created } = deriveBatch(wsRef.current, {
      name,
      ids,
      judgments,
      origin: { kind: 'ai', question, fields, parentId: batch.id, parentName: batch.name, stats },
    })
    setScreening(false)
    setSelectedId(null)
    setLimit(PAGE)
    persist(next)
    setNotice({
      kind: 'ok',
      text: `“${created.name}” — ${ids.length} of ${stats.total} postings matched, judged on ${fields.join(', ')}.`,
    })
  }

  // ── compensation normalization ────────────────────────────────────────────
  // Sends each posting's compensation blurb to the AI and stores the equivalent
  // hourly wage in CAD as `hourlyCad`. Batched, paced, cancellable, and
  // resumable: postings that already carry a figure are skipped, so a cancelled
  // or partly failed run picks up where it left off.
  //
  // Results are written to the shared pool, so a wage computed while looking at
  // one batch is immediately right in every other batch holding that posting.
  const runCompensation = useCallback(async ({ force = false } = {}) => {
    const current = wsRef.current
    if (!current || compAbort.current) return
    const target = activeBatch(current)
    if (!target) return
    const rows = batchPostings(current, target.id)

    const controller = new AbortController()
    compAbort.current = controller
    setComp({ done: 0, total: 0, failed: 0, note: 'starting…' })

    try {
      const { postings: updated, stats } = await normalizeAll(ai, rows, {
        signal: controller.signal,
        force,
        onNote: (note) => setComp((c) => (c ? { ...c, note } : c)),
        // A run over 570 postings takes minutes, so results land on screen as they
        // arrive and are checkpointed to IndexedDB periodically — a reload partway
        // through keeps what the run already paid for. Not every batch, though:
        // the workspace is a couple of megabytes, and writing all of it ~48 times
        // would cost more than the AI calls.
        onProgress: (rowsNow, st) => {
          setComp({ done: st.done, total: st.total, failed: st.failed, note: null })
          const merged = updatePostings(wsRef.current, rowsNow)
          setWs(merged)
          wsRef.current = merged
          if (st.batches % 5 === 0) saveWorkspace(user.id, merged)
        },
      })

      await persist(updatePostings(wsRef.current, updated))

      const used = Object.entries(stats.byProvider)
        .filter(([k]) => k && k !== 'null')
        .map(([k, n]) => `${n} via ${k}`)
        .join(', ')
      setNotice({
        kind: stats.failed ? 'warn' : 'ok',
        text:
          `Compensation normalized for ${stats.done} postings` +
          (used ? ` (${used})` : '') +
          (stats.skipped ? `, ${stats.skipped} had no figure to read` : '') +
          (stats.failed ? `, ${stats.failed} could not be read.` : '.') +
          (stats.errors.length ? '\n' + [...new Set(stats.errors)].slice(0, 4).join('\n') : ''),
      })
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setNotice({ kind: 'error', text: `Compensation normalization failed: ${err.message || err}` })
      }
    } finally {
      compAbort.current = null
      setComp(null)
    }
  }, [ai, user.id, persist])

  const stopCompensation = () => compAbort.current?.abort()

  // Normalization is deliberately manual. An import of 574 postings is ~48 AI
  // requests and several minutes, which is not something to start on the user's
  // behalf just because a key happens to be configured. The toolbar button
  // carries the outstanding count, and the notice after an import points at it,
  // so it stays discoverable without ever being automatic.

  // Abandon an in-flight run if the section is left, rather than letting it
  // write into a workspace nobody is looking at.
  useEffect(() => () => compAbort.current?.abort(), [])

  // ── derived views ─────────────────────────────────────────────────────────
  const facets = useMemo(() => ({
    arrangements: tally(postings, (r) => r.location.arrangement),
    cities: tally(postings, (r) => r.location.city),
    levels: tally(postings, (r) => r.levels),
    clusters: tally(postings, (r) => r.clusters),
  }), [postings])

  const visible = useMemo(
    () => sortPostings(filterPostings(postings, filters), sort.key, sort.dir),
    [postings, filters, sort]
  )

  const selected = useMemo(
    () => postings.find((p) => p.id === selectedId) || null,
    [postings, selectedId]
  )

  const pending = useMemo(() => pendingCount(postings), [postings])
  const filtered = visible.length !== postings.length
  useEffect(() => { setLimit(PAGE) }, [filters, sort])

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }))

  const toggleSort = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))

  // ── export ────────────────────────────────────────────────────────────────
  // Both exports write whatever the filters currently select, so narrowing to
  // "remote, 8 months, still open" and exporting that is one action.
  const download = (filename, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  const safeName = (batch?.name || 'postings').replace(/[\\/:*?"<>|]+/g, '_')
  const downloadJson = () =>
    download(`${safeName}.clean.json`, toCleanJson(visible, batch?.origin?.sources || []), 'application/json')
  const downloadCsv = () => download(`${safeName}.csv`, toCsv(visible), 'text/csv')

  // ── render ────────────────────────────────────────────────────────────────
  const hasBatches = !!(ws && ws.batches.length)

  return (
    <div className="ww" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo">ResuForge</span>
          {nav}
          {batch && (
            <span className="ww-count">
              <strong>{postings.length}</strong> postings
              {filtered && <> · <strong>{visible.length}</strong> shown</>}
            </span>
          )}
        </div>
        <div className="topbar-actions">
          <span className="user-email" title={user.email}>{user.email}</span>
          <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
          {hasBatches && (
            <>
              {comp ? (
                <button className="btn-ghost" onClick={stopCompensation}>Stop AI</button>
              ) : (
                <>
                  <button
                    className="btn-ghost"
                    onClick={() => (hasAnyKey(ai) ? runCompensation() : onOpenAi())}
                    title={hasAnyKey(ai)
                      ? "Convert each posting's compensation text to an hourly CAD wage"
                      : 'Add an AI key first'}
                  >
                    {pending > 0 ? `Normalize pay (${pending})` : 'Normalize pay'}
                  </button>
                  {postings.length > pending && (
                    <button
                      className="btn-ghost"
                      onClick={() => {
                        if (confirm(`Recalculate pay for all ${postings.length} postings in this batch?`))
                          runCompensation({ force: true })
                      }}
                      title="Redo every posting — needed after changing the exchange rate or hours per week"
                    >
                      Recalculate all
                    </button>
                  )}
                </>
              )}
              <button className="btn-ghost" onClick={downloadJson} title={`postings.clean.json for the ${visible.length} shown`}>
                Clean JSON
              </button>
              <button className="btn-ghost" onClick={downloadCsv} title={`postings.csv for the ${visible.length} shown`}>
                CSV
              </button>
              <button className="btn-danger" onClick={handleClearAll}>Clear all</button>
            </>
          )}
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(e) => { handleFiles(e.target.files, { asNew: importAsNew.current }); e.target.value = '' }}
      />

      {hasBatches && (
        <BatchBar
          ws={ws}
          active={batch}
          onSwitch={switchBatch}
          onNewFromFile={() => pickFiles(true)}
          onImportMore={() => pickFiles(false)}
          onScreen={() => (hasAnyKey(ai) ? setScreening(true) : onOpenAi())}
          onRename={handleRename}
          onDelete={handleDeleteBatch}
          canScreen={postings.length > 0}
        />
      )}

      {notice && (
        <div className={`ww-notice ww-notice--${notice.kind}`}>
          <pre>{notice.text}</pre>
          <button className="ww-notice-close" onClick={() => setNotice(null)} title="Dismiss">×</button>
        </div>
      )}

      {comp && (
        <div className="ww-progress">
          <div className="ww-progress-bar">
            <div
              className="ww-progress-fill"
              style={{ width: comp.total ? `${Math.round((comp.done / comp.total) * 100)}%` : '0%' }}
            />
          </div>
          <span className="ww-progress-text">
            Normalizing pay {comp.done}/{comp.total || '…'}
            {comp.failed > 0 && <> · {comp.failed} unreadable</>}
            {comp.note && <span className="ww-progress-note"> · {comp.note}</span>}
          </span>
          <button className="btn-ghost" onClick={stopCompensation}>Stop</button>
        </div>
      )}

      {loading ? (
        <div className="ww-empty"><p>Loading…</p></div>
      ) : !hasBatches ? (
        <EmptyState dragging={dragging} busy={busy} onPick={() => pickFiles(true)} />
      ) : (
        <>
          <Filters
            filters={filters}
            facets={facets}
            onChange={setFilter}
            onReset={() => setFilters(EMPTY_FILTERS)}
            onHideClosed={() =>
              setFilters((f) => ({ ...f, deadlineFrom: new Date().toISOString().slice(0, 10) }))
            }
            busy={busy}
          />

          {batch?.origin?.kind === 'ai' && <ScreenNote batch={batch} />}

          {batch?.report && (
            <>
              <button
                className="ww-report-toggle"
                onClick={() => setReportOpen((o) => !o)}
                aria-expanded={reportOpen}
              >
                {reportOpen ? '▾' : '▸'} Import report
                {batch.report.missing.length > 0 && (
                  <span className="ww-report-badge">
                    {batch.report.missing.length} field{batch.report.missing.length === 1 ? '' : 's'} incomplete
                  </span>
                )}
              </button>
              {reportOpen && <Report report={batch.report} />}
            </>
          )}

          <div className="ww-body">
            <div className="ww-table-wrap">
              <PostingsTable
                rows={visible.slice(0, limit)}
                sort={sort}
                onSort={toggleSort}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onRemove={handleRemove}
                judgments={batch?.judgments}
              />
              {visible.length === 0 && (
                <p className="ww-no-match">
                  {postings.length === 0 ? 'This batch is empty.' : 'Nothing matches these filters.'}
                </p>
              )}
              {limit < visible.length && (
                <div className="ww-more">
                  <button className="btn-ghost" onClick={() => setLimit((l) => l + PAGE)}>
                    Show {Math.min(PAGE, visible.length - limit)} more
                  </button>
                  <span className="ww-more-note">{limit} of {visible.length}</span>
                </div>
              )}
            </div>
            <aside className="ww-detail">
              {selected
                ? <Detail posting={selected} reason={batch?.judgments?.[selected.id]?.reason} />
                : <p className="ww-detail-hint">Select a posting to see the full record.</p>}
            </aside>
          </div>
        </>
      )}

      {screening && batch && (
        <ScreenDialog
          settings={ai}
          postings={postings}
          batchName={batch.name}
          onDone={handleScreened}
          onClose={() => setScreening(false)}
        />
      )}

      {dragging && hasBatches && (
        <div className="ww-drop-overlay">Drop to import as a new batch</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function BatchBar({ ws, active, onSwitch, onNewFromFile, onImportMore, onScreen, onRename, onDelete, canScreen }) {
  return (
    <div className="ww-batches">
      <div className="ww-batch-tabs">
        {ws.batches.map((b) => (
          <button
            key={b.id}
            className={`ww-batch${b.id === active?.id ? ' ww-batch--active' : ''}`}
            onClick={() => onSwitch(b.id)}
            title={describeBatch(b)}
          >
            {b.origin?.kind === 'ai' && <span className="ww-batch-mark" title="Created by an AI screen">◆</span>}
            {b.name}
            <span className="ww-batch-n">{b.ids.length}</span>
          </button>
        ))}
      </div>
      <div className="ww-batch-actions">
        <button className="btn-ghost" onClick={onScreen} disabled={!canScreen}
                title="Ask a question and keep only the postings that meet it">
          Screen with AI…
        </button>
        <button className="btn-ghost" onClick={onNewFromFile}>New batch from file…</button>
        <button className="btn-ghost" onClick={onImportMore}>Import more…</button>
        <button className="btn-ghost" onClick={onRename} disabled={!active}>Rename</button>
        <button className="btn-ghost" onClick={onDelete} disabled={!active}>Delete batch</button>
      </div>
    </div>
  )
}

function describeBatch(b) {
  const when = new Date(b.createdAt).toLocaleString()
  if (b.origin?.kind === 'ai') return `AI screen: “${b.origin.question}”\n${when}`
  if (b.origin?.kind === 'import') {
    const src = (b.origin.sources || []).map((s) => s.name).join(', ')
    return `Imported${src ? ` from ${src}` : ''}\n${when}`
  }
  return when
}

// A batch that came from a screen says what it was screened for, so a shortlist
// is never an unexplained list of jobs weeks later.
function ScreenNote({ batch }) {
  const o = batch.origin
  return (
    <div className="ww-screen-note">
      <strong>Screened from “{o.parentName}”</strong> for: {o.question}
      <span className="ww-screen-fields">
        judged on {o.fields.join(', ')}
        {o.stats?.failed > 0 && ` · ${o.stats.failed} unanswered and left out`}
      </span>
    </div>
  )
}

function EmptyState({ dragging, busy, onPick }) {
  return (
    <div className="ww-empty">
      <div className={`ww-dropzone${dragging ? ' ww-dropzone--over' : ''}`}>
        <h1>WaterlooWorks postings</h1>
        {busy ? (
          <p className="ww-busy">{busy}</p>
        ) : (
          <>
            <p>
              Drop a <code>waterlooworks-postings.json</code> file here, or
            </p>
            <button className="btn-primary" onClick={onPick}>Choose files…</button>
            <p className="ww-dropzone-note">
              That file comes from the WW-Scraper extension — run a scrape, then click
              <strong> Export to ResuForge</strong>. Postings are normalized here in your
              browser and kept on this device; nothing is uploaded.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Filters({ filters, facets, onChange, onReset, onHideClosed, busy }) {
  const active =
    Object.entries(filters).some(([k, v]) => v !== EMPTY_FILTERS[k])

  return (
    <div className="ww-filters">
      <input
        className="ww-search"
        value={filters.query}
        onChange={onChange('query')}
        placeholder="Search title, employer, summary, skills…"
        spellCheck={false}
      />
      <Select value={filters.arrangement} onChange={onChange('arrangement')} label="Any arrangement" options={facets.arrangements} />
      <Select value={filters.city} onChange={onChange('city')} label="Any city" options={facets.cities} />
      <Select value={filters.level} onChange={onChange('level')} label="Any level" options={facets.levels} />
      <Select value={filters.cluster} onChange={onChange('cluster')} label="Any discipline" options={facets.clusters} />
      <label className="ww-field" title="Hide postings whose deadline has passed this date">
        deadline ≥
        <input type="date" value={filters.deadlineFrom} onChange={onChange('deadlineFrom')} />
      </label>
      <label className="ww-field" title="Minimum hourly wage in CAD, judged on the bottom of a range">
        ≥ $
        <input
          type="number"
          className="ww-months"
          min="0"
          step="1"
          value={filters.minHourly}
          onChange={onChange('minHourly')}
        />
        /hr
      </label>
      <label className="ww-field" title="Minimum work-term length in months">
        ≥
        <input
          type="number"
          className="ww-months"
          min="1"
          max="24"
          value={filters.minMonths}
          onChange={onChange('minMonths')}
        />
        mo
      </label>
      <button className="btn-ghost" onClick={onHideClosed} title="Set the deadline floor to today">
        Hide closed
      </button>
      <button className="btn-ghost" onClick={onReset} disabled={!active}>Reset</button>
      {busy && <span className="ww-busy-inline">{busy}</span>}
    </div>
  )
}

function Select({ value, onChange, label, options }) {
  return (
    <select className="ww-select" value={value} onChange={onChange}>
      <option value="">{label}</option>
      {options.map(([name, n]) => (
        <option key={name} value={name}>{name} ({n})</option>
      ))}
    </select>
  )
}

const COLUMNS = [
  ['id', 'ID', 'ww-col-id'],
  ['title', 'Title', 'ww-col-title'],
  ['organization', 'Employer', 'ww-col-org'],
  ['city', 'City', 'ww-col-city'],
  ['arrangement', 'Arrangement', 'ww-col-arr'],
  ['hourlyCad', '$/hr CAD', 'ww-col-pay'],
  ['durationMonths', 'Mo', 'ww-col-num'],
  ['openings', 'Open', 'ww-col-num'],
  ['applicants', 'Apps', 'ww-col-num'],
  ['deadline', 'Deadline', 'ww-col-deadline'],
]

function PostingsTable({ rows, sort, onSort, selectedId, onSelect, onRemove, judgments }) {
  return (
    <table className="ww-table">
      <thead>
        <tr>
          {COLUMNS.map(([key, label, cls]) => (
            <th
              key={key}
              className={`${cls}${sort.key === key ? ' ww-sorted' : ''}`}
              onClick={() => onSort(key)}
              title={`Sort by ${label}`}
            >
              {label}
              {sort.key === key && <span className="ww-caret">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
            </th>
          ))}
          <th className="ww-col-x" aria-label="Remove" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            className={r.id === selectedId ? 'ww-row--selected' : undefined}
            onClick={() => onSelect(r.id)}
          >
            <td className="ww-col-id">{r.id}</td>
            <td className="ww-col-title">
              {r.title || <em>untitled</em>}
              {judgments?.[r.id]?.reason && (
                <span className="ww-row-reason">{judgments[r.id].reason}</span>
              )}
            </td>
            <td className="ww-col-org">{r.organization}</td>
            <td className="ww-col-city">{r.location.city}</td>
            <td className="ww-col-arr">{r.location.arrangement}</td>
            <td className="ww-col-pay">
              {r.hourlyCad
                ? <span className={r.hourlyCad.min == null ? 'ww-pay-na' : undefined}>{r.hourlyCad.text}</span>
                : <span className="ww-pay-pending" title="Not normalized yet">—</span>}
            </td>
            <td className="ww-col-num">{r.duration?.months ?? ''}</td>
            <td className="ww-col-num">{r.openings ?? ''}</td>
            <td className="ww-col-num">{r.applicants ?? ''}</td>
            <td className="ww-col-deadline">{r.deadline?.date ?? ''}</td>
            <td className="ww-col-x">
              <button
                className="ww-remove"
                // Without this the click also selects the row that is about to
                // vanish, leaving the detail panel showing a posting the batch
                // no longer contains.
                onClick={(e) => { e.stopPropagation(); onRemove(r.id) }}
                title="Remove from this batch (the posting itself is kept)"
              >
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Detail({ posting: p, reason }) {
  const loc = [p.location.city, p.location.province, p.location.country].filter(Boolean).join(', ')
  return (
    <div className="ww-detail-body">
      <h2>{p.title || `Posting ${p.id}`}</h2>
      <div className="ww-detail-sub">
        {[p.organization, p.division].filter(Boolean).join(' · ')}
      </div>

      {reason && <div className="ww-detail-reason">Kept because: {reason}</div>}

      <dl className="ww-facts">
        <Fact label="ID" value={p.id} />
        <Fact label="Location" value={loc} />
        <Fact label="Arrangement" value={p.location.arrangement} />
        <Fact label="Pay (CAD/hr)" value={p.hourlyCad && payDetail(p.hourlyCad)} />
        <Fact label="Posting states" value={p.hourlyCad && statedDetail(p.hourlyCad)} />
        <Fact label="Deadline" value={p.deadline?.raw} />
        <Fact label="Work term" value={p.workTerm?.raw} />
        <Fact label="Duration" value={p.duration?.raw} />
        <Fact label="Openings" value={p.openings} />
        <Fact label="Applicants" value={p.applicants} />
        <Fact label="Levels" value={p.levels.join(', ')} />
        <Fact label="Job type" value={p.jobType} />
        <Fact label="Apply by" value={p.application.method} />
        <Fact label="Documents" value={p.application.documents.join(', ')} />
        <Fact label="Scraped" value={p.scrapedAt && new Date(p.scrapedAt).toLocaleString()} />
      </dl>

      <Section title="Summary" body={p.summary} />
      <Section title="Responsibilities" body={p.responsibilities} />
      <Section title="Required skills" body={p.skills} />
      <Section title="Compensation and benefits" body={p.compensation} />
      {p.clusters.length > 0 && (
        <section className="ww-section">
          <h3>Targeted disciplines</h3>
          <ul className="ww-clusters">
            {p.clusters.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </section>
      )}
      <Section title="Special requirements" body={p.specialRequirements} />
      <Section title="Transportation and housing" body={p.transportationHousing} />
      <Section title="Schedule notes" body={p.scheduleNotes} />
      <Section title="Application notes" body={p.application.additionalInfo} />
      <Section title="Location notes" body={p.location.note} />
      {p.additionalInformation.length > 0 && (
        <Section title="Additional information" body={p.additionalInformation.join('\n')} />
      )}
      {p.extra && (
        <section className="ww-section">
          <h3>Unmapped fields</h3>
          <dl className="ww-facts">
            {Object.entries(p.extra).map(([k, v]) => (
              <Fact key={k} label={k} value={String(v)} />
            ))}
          </dl>
        </section>
      )}
    </div>
  )
}

// One readable line for the detail panel: the figure, then how it was arrived at.
// Showing the provider matters for auditing — if a number looks wrong it's useful
// to know which model produced it and what the source currency was.
function payDetail(h) {
  // The table shows the bottom of the range; here the full span is worth seeing,
  // along with which model read the posting.
  const how = [
    h.min != null && h.max != null && Math.abs(h.max - h.min) >= 0.01
      ? `range ${formatRange(h.min, h.max)}`
      : null,
    h.note || null,
    h.provider ? `via ${h.provider}` : null,
  ].filter(Boolean).join(' · ')
  return how ? `${h.text} — ${how}` : h.text
}

// The figure as written in the posting, so a converted number can be checked
// against its source at a glance.
function statedDetail(h) {
  if (!h.source) return null
  const { min, max, period, currency } = h.source
  const amount = min === max ? `${min}` : `${min}–${max}`
  return `${currency} ${amount} ${period}`
}

function Fact({ label, value }) {
  if (value == null || value === '') return null
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

function Section({ title, body }) {
  if (!body) return null
  return (
    <section className="ww-section">
      <h3>{title}</h3>
      <p className="ww-prose">{body}</p>
    </section>
  )
}

function Report({ report }) {
  return (
    <div className="ww-report">
      <div className="ww-report-col">
        <h3>Imported</h3>
        <p>
          {report.read} records read · {report.duplicates} duplicate ids collapsed ·{' '}
          {report.count} postings kept
        </p>
        <ul className="ww-report-list">
          {report.sources.map((s, i) => (
            // Keyed by position: importing the same filename twice is allowed,
            // and those entries are both real.
            <li key={`${s.name}-${i}`}><code>{s.name}</code> — {s.count}</li>
          ))}
        </ul>
        {report.skipped.length > 0 && (
          <ul className="ww-report-list ww-report-list--warn">
            {report.skipped.map((s, i) => <li key={`${s.name}-${i}`}>{s.name}: {s.reason}</li>)}
          </ul>
        )}
      </div>

      <div className="ww-report-col">
        <h3>Completeness</h3>
        {report.missing.length === 0 ? (
          <p>Every posting has all the key fields.</p>
        ) : (
          <ul className="ww-report-list">
            {report.missing.map((m) => (
              <li key={m.label}>{m.n} missing {m.label}</li>
            ))}
          </ul>
        )}
        {report.unmapped.count > 0 && (
          <p className="ww-report-warn">
            {report.unmapped.count} postings carry fields this pipeline doesn't map:{' '}
            {report.unmapped.keys.join(', ')}
          </p>
        )}
      </div>

      <div className="ww-report-col">
        <h3>Breakdown</h3>
        <p className="ww-report-tally">
          <strong>Arrangement</strong>{' '}
          {report.arrangements.map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}
        </p>
        <p className="ww-report-tally">
          <strong>Top cities</strong>{' '}
          {report.cities.slice(0, 8).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}
        </p>
        <p className="ww-report-tally">
          <strong>Levels</strong>{' '}
          {report.levels.map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}
        </p>
      </div>
    </div>
  )
}
