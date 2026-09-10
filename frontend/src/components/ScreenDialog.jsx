// Ask a subjective question of a batch and keep only the postings that meet it.
//
// The run is two passes and the dialog shows both, because the first one is
// where the token saving comes from and is also where the model can be wrong
// cheaply: it picks which fields the question needs, and you get to correct that
// choice before the second pass sends those fields for every posting.
import { useState } from 'react'
import { SCREEN_FIELDS, FIELD_KEYS, chooseFields, screenPostings, projectionSaving } from '../lib/screen'
import './ScreenDialog.css'

const EXAMPLES = [
  'involves building or operating ML infrastructure, not just using ML',
  'is a backend or systems role rather than frontend',
  'explicitly welcomes first or second year students',
]

// Only offered once a resume is attached, since they lean on it.
const RESUME_EXAMPLES = [
  'I could plausibly get an interview for, given my experience',
  'uses a language or framework already on my resume',
  'lines up with the strongest project on my resume',
]

export default function ScreenDialog({ settings, postings, batchName, resume, onDone, onClose }) {
  const [question, setQuestion] = useState('')
  const [fields, setFields] = useState(null)     // null until pass 1 has run
  const [stage, setStage] = useState('ask')      // ask | fields | running | done
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [name, setName] = useState('')
  const [abort, setAbort] = useState(null)
  // On by default when a resume is attached: someone who sent one across almost
  // always means their questions to be read against it.
  const [useResume, setUseResume] = useState(!!resume)
  const resumeText = useResume && resume ? resume.text : null

  const saving = fields ? projectionSaving(postings, fields) : null

  const pickFields = async () => {
    setError(null)
    setStage('running')
    try {
      const r = await chooseFields(settings, question.trim(), { resume: resumeText })
      setFields(r.fields)
      setName(suggestName(question))
      setStage('fields')
    } catch (err) {
      setError(err.message || String(err))
      setStage('ask')
    }
  }

  const run = async () => {
    setError(null)
    setStage('running')
    const ctrl = new AbortController()
    setAbort(ctrl)
    try {
      const r = await screenPostings(settings, postings, question.trim(), fields, {
        signal: ctrl.signal,
        onProgress: setProgress,
        resume: resumeText,
      })
      setResult(r)
      setStage('done')
    } catch (err) {
      setError(err.message || String(err))
      setStage('fields')
    } finally {
      setAbort(null)
    }
  }

  const toggle = (k) =>
    setFields((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]))

  const create = () => {
    onDone({
      name: name.trim() || suggestName(question),
      ids: result.kept.map((p) => p.id),
      judgments: result.judgments,
      question: question.trim(),
      fields,
      stats: result.stats,
      resumeName: resumeText ? resume.name : null,
    })
  }

  return (
    <div className="sd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && stage !== 'running') onClose() }}>
      <div className="sd" role="dialog" aria-label="Screen postings with AI">
        <header className="sd-head">
          <h2>Screen “{batchName}”</h2>
          <span className="sd-count">{postings.length} postings</span>
          <button className="sd-x" onClick={onClose} disabled={stage === 'running'}>×</button>
        </header>

        <label className="sd-field">
          <span>Keep only postings that…</span>
          <textarea
            value={question}
            onChange={(e) => { setQuestion(e.target.value); setFields(null); setStage('ask') }}
            placeholder="involve building ML infrastructure, not just using a model"
            rows={3}
            disabled={stage === 'running'}
          />
        </label>

        {resume && (
          <label className="sd-resume">
            <input
              type="checkbox"
              checked={useResume}
              onChange={(e) => { setUseResume(e.target.checked); setFields(null); setStage('ask') }}
              disabled={stage === 'running'}
            />
            Judge against my resume (<strong>{resume.name}</strong>) — sent with every request,
            so questions can say “my”, “I” or name a project on it.
          </label>
        )}

        {stage === 'ask' && (
          <div className="sd-examples">
            {[...(useResume ? RESUME_EXAMPLES : []), ...EXAMPLES].map((ex) => (
              <button key={ex} className="sd-example" onClick={() => setQuestion(ex)}>{ex}</button>
            ))}
          </div>
        )}

        {fields && stage !== 'done' && (
          <section className="sd-fields">
            <h3>Fields this question needs</h3>
            <p className="sd-help">
              Chosen by the AI, and sent for every posting — so anything ticked that can't change the
              answer is wasted on all {postings.length}. Correct it if it got this wrong.
            </p>
            <div className="sd-chips">
              {FIELD_KEYS.map((k) => (
                <button
                  key={k}
                  className={`sd-chip${fields.includes(k) ? ' sd-chip--on' : ''}`}
                  onClick={() => toggle(k)}
                  disabled={stage === 'running'}
                >
                  {SCREEN_FIELDS[k].label}
                </button>
              ))}
            </div>
            {saving && (
              <p className="sd-saving">
                Sending <strong>{saving.percent}% less</strong> per posting than the full record.
              </p>
            )}
          </section>
        )}

        {stage === 'running' && (
          <div className="sd-progress">
            {progress
              ? <>Judged {progress.judged}/{progress.total} · {progress.kept} kept
                  {progress.failed > 0 && <> · {progress.failed} unanswered</>}</>
              : fields ? 'Starting…' : 'Working out which fields this question needs…'}
            {abort && <button className="btn-ghost" onClick={() => abort.abort()}>Stop</button>}
          </div>
        )}

        {stage === 'done' && result && (
          <section className="sd-result">
            <p className="sd-result-line">
              <strong>{result.kept.length}</strong> of {result.stats.total} postings match.
              {result.stats.failed > 0 && (
                <span className="sd-warn"> {result.stats.failed} went unanswered and were left out.</span>
              )}
            </p>
            <ul className="sd-preview">
              {result.kept.slice(0, 6).map((p) => (
                <li key={p.id}>
                  <strong>{p.title}</strong> — {p.organization}
                  <span className="sd-reason">{result.judgments[p.id]?.reason}</span>
                </li>
              ))}
              {result.kept.length > 6 && <li className="sd-more">…and {result.kept.length - 6} more</li>}
            </ul>
            <label className="sd-field">
              <span>New batch name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </section>
        )}

        {error && <div className="sd-error">{error}</div>}

        <footer className="sd-foot">
          <button className="btn-ghost" onClick={onClose} disabled={stage === 'running'}>Cancel</button>
          {stage === 'ask' && (
            <button className="btn-primary" onClick={pickFields} disabled={!question.trim()}>
              Choose fields
            </button>
          )}
          {stage === 'fields' && (
            <button className="btn-primary" onClick={run} disabled={!fields.length}>
              Screen {postings.length} postings
            </button>
          )}
          {stage === 'done' && (
            <button className="btn-primary" onClick={create} disabled={!result.kept.length}>
              Create batch ({result.kept.length})
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

// A short batch name from the question, since most questions are longer than a
// label should be.
function suggestName(q) {
  const s = String(q).trim().replace(/\s+/g, ' ')
  return s.length <= 34 ? s : s.slice(0, 32).replace(/\s\S*$/, '') + '…'
}
