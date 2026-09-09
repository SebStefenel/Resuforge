// Picks which section of the app is on screen.
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
import { useEffect, useState } from 'react'
import App from '../App'
import WaterlooWorks from './WaterlooWorks'
import './Shell.css'

function viewFromHash() {
  const name = window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0]
  return name === 'ww' ? 'ww' : 'resume'
}

export default function Shell({ user }) {
  const [view, setView] = useState(viewFromHash)

  useEffect(() => {
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const nav = <ViewNav current={view} />

  return view === 'ww'
    ? <WaterlooWorks user={user} nav={nav} />
    : <App user={user} nav={nav} />
}

// Rendered inside each section's own top bar, so there's one bar rather than a
// strip above a strip.
export function ViewNav({ current }) {
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
    </nav>
  )
}
