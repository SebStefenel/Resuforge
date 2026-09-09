// The WaterlooWorks section: import a scrape, normalize it, browse it, export it.
//
// The scraper extension (WW-Scraper) collects postings into a JSON file and its
// "Export to ResuForge" button drops you here. Everything downstream of that
// file — the normalization that used to be `tools/clean.js`, the completeness
// report it printed, and the postings.clean.json / postings.csv it wrote — now
// happens in this page. See lib/wwClean.js.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { loadDataset, saveDataset, clearDataset } from '../lib/wwStore'
import {
  mergeDocuments, buildReport, toCsv, toCleanJson, tally,
  filterPostings, sortPostings, EMPTY_FILTERS,
} from '../lib/wwClean'
import './WaterlooWorks.css'

const PAGE = 200 // rows added per "show more" — full tables run to a few thousand

export default function WaterlooWorks({ user, nav }) {
  const [dataset, setDataset] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null) // status line while parsing
  const [notice, setNotice] = useState(null) // { kind: 'error' | 'warn' | 'ok', text }
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [sort, setSort] = useState({ key: 'deadline', dir: 'asc' })
  const [selectedId, setSelectedId] = useState(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef(null)

  useEffect(() => {
    let cancelled = false
    loadDataset(user.id).then((d) => {
      if (cancelled) return
      if (d) setDataset(d)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [user.id])

  // ── import ────────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (fileList) => {
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

    const previous = dataset ? dataset.postings : []
    const merged = mergeDocuments(docs, { into: previous })
    const sources = [...(dataset ? dataset.sources : []), ...merged.sources]
    const report = buildReport(merged.postings, { ...merged, sources })
    const next = {
      postings: merged.postings,
      report,
      sources,
      importedAt: new Date().toISOString(),
    }

    setDataset(next)
    setSelectedId(null)
    setLimit(PAGE)
    setBusy(null)

    const stored = await saveDataset(user.id, next)
    const added = merged.postings.length - previous.length
    const problems = [
      ...bad,
      ...merged.skipped.map((s) => `${s.name}: ${s.reason}`),
      ...(stored ? [] : ["Couldn't save to this browser — the import is in memory only."]),
    ]
    setNotice({
      kind: problems.length ? 'warn' : 'ok',
      text:
        `Imported ${merged.read} records from ${merged.sources.length} file` +
        `${merged.sources.length === 1 ? '' : 's'} — ${added} new, ` +
        `${merged.duplicates} duplicate id${merged.duplicates === 1 ? '' : 's'} collapsed.` +
        (problems.length ? '\n' + problems.join('\n') : ''),
    })
  }, [dataset, user.id])

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

  const handleClear = async () => {
    if (!confirm('Remove the imported postings from this browser?')) return
    await clearDataset(user.id)
    setDataset(null)
    setSelectedId(null)
    setFilters(EMPTY_FILTERS)
    setNotice(null)
  }

  // ── derived views ─────────────────────────────────────────────────────────
  const postings = dataset ? dataset.postings : []

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

  const downloadJson = () =>
    download('postings.clean.json', toCleanJson(visible, dataset.sources), 'application/json')
  const downloadCsv = () => download('postings.csv', toCsv(visible), 'text/csv')

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="ww" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo">ResuForge</span>
          {nav}
          {dataset && (
            <span className="ww-count">
              <strong>{postings.length}</strong> postings
              {filtered && <> · <strong>{visible.length}</strong> shown</>}
              <span className="ww-imported">
                imported {new Date(dataset.importedAt).toLocaleString()}
              </span>
            </span>
          )}
        </div>
        <div className="topbar-actions">
          <span className="user-email" title={user.email}>{user.email}</span>
          <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
          {dataset && (
            <>
              <button className="btn-ghost" onClick={() => fileInput.current?.click()}>
                Import more…
              </button>
              <button
                className="btn-ghost"
                onClick={downloadJson}
                title={`Write postings.clean.json for the ${visible.length} postings shown`}
              >
                Clean JSON
              </button>
              <button
                className="btn-ghost"
                onClick={downloadCsv}
                title={`Write postings.csv for the ${visible.length} postings shown`}
              >
                CSV
              </button>
              <button className="btn-danger" onClick={handleClear}>Clear</button>
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
        onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
      />

      {notice && (
        <div className={`ww-notice ww-notice--${notice.kind}`}>
          <pre>{notice.text}</pre>
          <button className="ww-notice-close" onClick={() => setNotice(null)} title="Dismiss">×</button>
        </div>
      )}

      {loading ? (
        <div className="ww-empty"><p>Loading…</p></div>
      ) : !dataset ? (
        <EmptyState
          dragging={dragging}
          busy={busy}
          onPick={() => fileInput.current?.click()}
        />
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

          <button
            className="ww-report-toggle"
            onClick={() => setReportOpen((o) => !o)}
            aria-expanded={reportOpen}
          >
            {reportOpen ? '▾' : '▸'} Import report
            {dataset.report.missing.length > 0 && (
              <span className="ww-report-badge">
                {dataset.report.missing.length} field{dataset.report.missing.length === 1 ? '' : 's'} incomplete
              </span>
            )}
          </button>
          {reportOpen && <Report report={dataset.report} />}

          <div className="ww-body">
            <div className="ww-table-wrap">
              <PostingsTable
                rows={visible.slice(0, limit)}
                sort={sort}
                onSort={toggleSort}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              {visible.length === 0 && (
                <p className="ww-no-match">Nothing matches these filters.</p>
              )}
              {limit < visible.length && (
                <div className="ww-more">
                  <button className="btn-ghost" onClick={() => setLimit((l) => l + PAGE)}>
                    Show {Math.min(PAGE, visible.length - limit)} more
                  </button>
                  <span className="ww-more-note">
                    {limit} of {visible.length}
                  </span>
                </div>
              )}
            </div>
            <aside className="ww-detail">
              {selected
                ? <Detail posting={selected} />
                : <p className="ww-detail-hint">Select a posting to see the full record.</p>}
            </aside>
          </div>
        </>
      )}

      {dragging && dataset && (
        <div className="ww-drop-overlay">Drop to import into this dataset</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

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
  ['durationMonths', 'Mo', 'ww-col-num'],
  ['openings', 'Open', 'ww-col-num'],
  ['applicants', 'Apps', 'ww-col-num'],
  ['deadline', 'Deadline', 'ww-col-deadline'],
]

function PostingsTable({ rows, sort, onSort, selectedId, onSelect }) {
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
            <td className="ww-col-title">{r.title || <em>untitled</em>}</td>
            <td className="ww-col-org">{r.organization}</td>
            <td className="ww-col-city">{r.location.city}</td>
            <td className="ww-col-arr">{r.location.arrangement}</td>
            <td className="ww-col-num">{r.duration?.months ?? ''}</td>
            <td className="ww-col-num">{r.openings ?? ''}</td>
            <td className="ww-col-num">{r.applicants ?? ''}</td>
            <td className="ww-col-deadline">{r.deadline?.date ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Detail({ posting: p }) {
  const loc = [p.location.city, p.location.province, p.location.country].filter(Boolean).join(', ')
  return (
    <div className="ww-detail-body">
      <h2>{p.title || `Posting ${p.id}`}</h2>
      <div className="ww-detail-sub">
        {[p.organization, p.division].filter(Boolean).join(' · ')}
      </div>

      <dl className="ww-facts">
        <Fact label="ID" value={p.id} />
        <Fact label="Location" value={loc} />
        <Fact label="Arrangement" value={p.location.arrangement} />
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
