// Picks which section of the app is on screen, and owns the things both
// sections share: the section nav and the AI provider settings.
//
// Routing is by hash rather than by path, which needs no router dependency and
// no server rewrite — the deployed frontend is static files on Vercel, and a
// hash never reaches the server at all.
//
// The inactive section is unmounted, not hidden. The editor measures its own
// panel widths from the DOM and rescales them on window resize; inside a
// `display: none` subtree every width reads as 0, so a resize while hidden
// would persist collapsed panels. Unmounting is also why App flushes a pending
// save on teardown — see the unmount effect there.
//
// AI settings are loaded once here rather than per section: both sections get
// the same object, and editing them in one place can't leave the other holding a
// stale key.
import { useEffect, useState, useCallback } from 'react'
import App from '../App'
import WaterlooWorks from './WaterlooWorks'
import AiSettings from './AiSettings'
import { loadAiSettings, saveAiSettings, DEFAULT_AI_SETTINGS } from '../lib/aiStore'
import { hasAnyKey } from '../lib/ai'
import './Shell.css'

function viewFromHash() {
  const name = window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0]
  return name === 'ww' ? 'ww' : 'resume'
}

export default function Shell({ user }) {
  const [view, setView] = useState(viewFromHash)
  const [ai, setAi] = useState(DEFAULT_AI_SETTINGS)
  const [aiLoaded, setAiLoaded] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiSaveError, setAiSaveError] = useState(null)

  useEffect(() => {
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    let cancelled = false
    loadAiSettings(user.id).then(({ settings, error }) => {
      if (cancelled) return
      setAi(settings)
      setAiLoaded(true)
      // A load failure (most likely: migration 0004 not applied yet) must not
      // block the app — it only means AI features are unavailable.
      if (error) setAiSaveError(`Couldn't load AI settings: ${error}`)
    })
    return () => { cancelled = true }
  }, [user.id])

  const saveAi = useCallback(async (next) => {
    setAiSaveError(null)
    try {
      await saveAiSettings(user.id, next)
      setAi(next)
    } catch (err) {
      setAiSaveError(err.message || String(err))
      throw err
    }
  }, [user.id])

  const nav = (
    <ViewNav
      current={view}
      onOpenAi={() => setAiOpen(true)}
      aiConfigured={!aiLoaded || hasAnyKey(ai)}
    />
  )

  return (
    <>
      {view === 'ww'
        ? <WaterlooWorks user={user} nav={nav} ai={ai} onOpenAi={() => setAiOpen(true)} />
        : <App user={user} nav={nav} />}
      {aiOpen && (
        <AiSettings
          settings={ai}
          onSave={saveAi}
          onClose={() => setAiOpen(false)}
          saveError={aiSaveError}
        />
      )}
    </>
  )
}

// Rendered inside each section's own top bar, so there's one bar rather than a
// strip above a strip.
export function ViewNav({ current, onOpenAi, aiConfigured }) {
  return (
    <nav className="view-nav">
      <a
        href="#/resume"
        className={`view-nav-link${current === 'resume' ? ' view-nav-link--active' : ''}`}
      >
        Resume
      </a>
      <a
        href="#/ww"
        className={`view-nav-link${current === 'ww' ? ' view-nav-link--active' : ''}`}
        title="Import and process WaterlooWorks postings"
      >
        WaterlooWorks
      </a>
      <button
        className={`ai-gear${aiConfigured ? '' : ' ai-gear--unset'}`}
        onClick={onOpenAi}
        title={aiConfigured ? 'AI provider settings' : 'No AI key set yet — click to add one'}
      >
        AI
      </button>
    </nav>
  )
}
