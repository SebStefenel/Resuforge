import { useState, useRef, useEffect } from 'react'
import './ResumeSwitcher.css'

// Dropdown listing the user's resumes, with new / duplicate / delete.
// Switching is disabled while a save is in flight so a pending write can't
// land against the wrong document.
export default function ResumeSwitcher({
  resumes, currentId, busy, onSwitch, onCreate, onDuplicate, onDelete,
}) {
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
        setConfirmDelete(null)
      }
    }
    const onEsc = (e) => {
      if (e.key === 'Escape') { setOpen(false); setConfirmDelete(null) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const current = resumes.find((r) => r.id === currentId)
  const label = current?.resume_name || 'resume'

  const act = (fn) => (e) => {
    e.stopPropagation()
    setOpen(false)
    setConfirmDelete(null)
    fn()
  }

  return (
    <div className="resume-switcher" ref={ref}>
      <button
        className="btn-ghost resume-switcher-toggle"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title={busy ? 'Finishing save…' : 'Switch resume'}
      >
        <span className="resume-switcher-label">{label}</span>
        <span className="resume-switcher-count">
          {resumes.length > 1 ? `${resumes.length}` : ''}
        </span>
        <span className="dropdown-caret">▾</span>
      </button>

      {open && (
        <div className="resume-switcher-menu">
          <div className="resume-switcher-list">
            {resumes.map((r) => (
              <div
                key={r.id}
                className={`resume-row${r.id === currentId ? ' resume-row--active' : ''}`}
              >
                <button
                  className="resume-row-main"
                  onClick={act(() => r.id !== currentId && onSwitch(r.id))}
                  title={r.resume_name}
                >
                  <span className="resume-row-name">{r.resume_name || 'resume'}</span>
                  {r.id === currentId && <span className="resume-row-badge">open</span>}
                </button>

                <div className="resume-row-actions">
                  <button
                    className="resume-icon-btn"
                    onClick={act(() => onDuplicate(r.id))}
                    title="Duplicate this resume"
                    aria-label={`Duplicate ${r.resume_name}`}
                  >
                    Copy
                  </button>
                  {confirmDelete === r.id ? (
                    <button
                      className="resume-icon-btn resume-icon-btn--danger"
                      onClick={act(() => onDelete(r.id))}
                      title="Click again to confirm"
                    >
                      Sure?
                    </button>
                  ) : (
                    <button
                      className="resume-icon-btn"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(r.id) }}
                      disabled={resumes.length === 1}
                      title={
                        resumes.length === 1
                          ? "Can't delete your only resume"
                          : 'Delete this resume'
                      }
                      aria-label={`Delete ${r.resume_name}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button className="resume-switcher-new" onClick={act(onCreate)}>
            + New resume
          </button>
        </div>
      )}
    </div>
  )
}
