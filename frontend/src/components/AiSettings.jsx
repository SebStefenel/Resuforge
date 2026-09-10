// Where the two API keys are entered. Gemini is the preferred provider and GLM
// the fallback; the panel says so, because which slot a key goes in decides how
// much of it gets spent.
import { useState } from 'react'
import { DEFAULT_AI_SETTINGS } from '../lib/aiStore'
import { testProvider, geminiCooldown, clearGeminiCooldown } from '../lib/ai'
import './AiSettings.css'

export default function AiSettings({ settings, onSave, onClose, saveError }) {
  const [draft, setDraft] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [tests, setTests] = useState({}) // provider -> { ok, text } | { error }
  const [testing, setTesting] = useState(null)
  const [reveal, setReveal] = useState({})

  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }))

  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (provider) => {
    setTesting(provider)
    setTests((t) => ({ ...t, [provider]: null }))
    try {
      // Tests the values on screen, not the saved ones — otherwise you'd have to
      // save a wrong key before you could find out it was wrong.
      const r = await testProvider(draft, provider)
      setTests((t) => ({ ...t, [provider]: { ok: true, text: `${r.model} replied in ${r.ms}ms` } }))
    } catch (err) {
      setTests((t) => ({ ...t, [provider]: { ok: false, text: err.message || String(err) } }))
    } finally {
      setTesting(null)
    }
  }

  const cooling = geminiCooldown()

  return (
    <div className="ai-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ai-modal" role="dialog" aria-label="AI provider settings">
        <header className="ai-head">
          <h2>AI providers</h2>
          <button className="ai-x" onClick={onClose} title="Close">×</button>
        </header>

        <p className="ai-intro">
          Gemini is used for everything it can handle — it's the free tier, so it should do
          the bulk of the work. GLM is only called once Gemini's <strong>daily</strong> quota
          is spent, its key is refused, or it keeps failing. A per-minute rate limit makes the
          app wait for Gemini rather than spend your paid plan.
        </p>

        {cooling && (
          <div className="ai-cooldown">
            Gemini is currently {cooling.reason} ({Math.ceil(cooling.msLeft / 1000)}s left).
            <button className="ai-link" onClick={() => { clearGeminiCooldown(); setTests({}) }}>
              Clear and retry Gemini
            </button>
          </div>
        )}

        <Slot
          title="Gemini"
          badge="preferred · free tier"
          keyValue={draft.geminiKey}
          onKey={set('geminiKey')}
          model={draft.geminiModel}
          onModel={set('geminiModel')}
          modelHint="e.g. gemini-2.5-flash, gemini-2.5-flash-lite"
          help="Get a key at aistudio.google.com/apikey — called directly from this page."
          revealed={!!reveal.gemini}
          onReveal={() => setReveal((r) => ({ ...r, gemini: !r.gemini }))}
          test={tests.gemini}
          testing={testing === 'gemini'}
          onTest={() => runTest('gemini')}
        />

        <Slot
          title="GLM"
          badge="fallback · monthly plan"
          keyValue={draft.glmKey}
          onKey={set('glmKey')}
          model={draft.glmModel}
          onModel={set('glmModel')}
          modelHint="e.g. glm-4.6"
          help="Routed through the compile backend, because api.z.ai refuses cross-origin browser calls."
          revealed={!!reveal.glm}
          onReveal={() => setReveal((r) => ({ ...r, glm: !r.glm }))}
          test={tests.glm}
          testing={testing === 'glm'}
          onTest={() => runTest('glm')}
        >
          <label className="ai-field">
            <span>Base URL</span>
            <input value={draft.glmBaseUrl} onChange={set('glmBaseUrl')} spellCheck={false} />
            <small>
              Only <code>api.z.ai</code> and <code>open.bigmodel.cn</code> are accepted by the proxy.
            </small>
          </label>
        </Slot>

        <section className="ai-slot">
          <h3>Conversion constants</h3>
          <p className="ai-help">
            Pinned into the prompt so the model never invents a rate. Two postings converted
            weeks apart stay comparable, and a figure that looks wrong is a number you can fix here.
          </p>
          <div className="ai-row">
            <label className="ai-field ai-field--narrow">
              <span>1 USD in CAD</span>
              <input type="number" step="0.01" min="0.1" max="5"
                     value={draft.usdCad} onChange={set('usdCad')} />
            </label>
            <label className="ai-field ai-field--narrow">
              <span>Hours per week</span>
              <input type="number" step="1" min="1" max="80"
                     value={draft.hoursPerWeek} onChange={set('hoursPerWeek')} />
            </label>
          </div>
        </section>

        {saveError && <div className="ai-error">{saveError}</div>}

        <footer className="ai-foot">
          <button
            className="ai-link"
            onClick={() => setDraft({ ...DEFAULT_AI_SETTINGS, ...keysOf(draft) })}
            title="Restore default models and constants, keeping your keys"
          >
            Reset models &amp; constants
          </button>
          <div className="ai-foot-right">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

// Keys are the one thing a "reset to defaults" must never wipe.
const keysOf = (d) => ({ geminiKey: d.geminiKey, glmKey: d.glmKey })

function Slot({
  title, badge, keyValue, onKey, model, onModel, modelHint, help,
  revealed, onReveal, test, testing, onTest, children,
}) {
  return (
    <section className="ai-slot">
      <h3>
        {title} <span className="ai-badge">{badge}</span>
      </h3>
      <p className="ai-help">{help}</p>

      <label className="ai-field">
        <span>API key</span>
        <div className="ai-key-row">
          <input
            type={revealed ? 'text' : 'password'}
            value={keyValue}
            onChange={onKey}
            placeholder="paste your key"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn-ghost" onClick={onReveal} title={revealed ? 'Hide' : 'Show'}>
            {revealed ? 'Hide' : 'Show'}
          </button>
          <button className="btn-ghost" onClick={onTest} disabled={testing || !keyValue.trim()}>
            {testing ? 'Testing…' : 'Test'}
          </button>
        </div>
      </label>

      <label className="ai-field">
        <span>Model</span>
        <input value={model} onChange={onModel} spellCheck={false} />
        <small>{modelHint}</small>
      </label>

      {children}

      {test && (
        <div className={`ai-test ${test.ok ? 'ai-test--ok' : 'ai-test--bad'}`}>
          {test.ok ? '✓ ' : '✕ '}{test.text}
        </div>
      )}
    </section>
  )
}
