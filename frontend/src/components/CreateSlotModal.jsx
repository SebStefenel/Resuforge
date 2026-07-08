import { useState, useEffect, useRef } from 'react'
import './CreateSlotModal.css'

export default function CreateSlotModal({
  selectedText,
  from,
  to,
  existingCategories,
  onCreate,
  onClose,
}) {
  const [mode, setMode] = useState(existingCategories.length > 0 ? 'choose' : 'new')
  // 'new' = create new category, 'existing' = add preset to existing
  const [categoryName, setCategoryName] = useState('')
  const [existingCat, setExistingCat] = useState(existingCategories[0] ?? '')
  const [presetName, setPresetName] = useState('')
  const firstInputRef = useRef(null)

  useEffect(() => {
    firstInputRef.current?.focus()
  }, [mode])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  function handleSubmit(e) {
    e.preventDefault()
    const cat = mode === 'new' ? categoryName.trim() : existingCat
    const preset = presetName.trim()
    if (!cat || !preset) return

    onCreate({
      categoryName: cat,
      presetName: preset,
      value: selectedText,
      from,
      to,
    })
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span>Create Variant Slot</span>
          <button className="modal-close btn-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="modal-section">
          <div className="modal-label">Selected text (will become the preset value)</div>
          <pre className="modal-preview">{selectedText}</pre>
        </div>

        {existingCategories.length > 0 && (
          <div className="modal-tabs">
            <button
              className={`modal-tab ${mode === 'new' ? 'modal-tab--active' : ''}`}
              onClick={() => setMode('new')}
            >New category</button>
            <button
              className={`modal-tab ${mode === 'existing' ? 'modal-tab--active' : ''}`}
              onClick={() => setMode('existing')}
            >Add to existing</button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="modal-form">
          {mode === 'new' ? (
            <div className="modal-field">
              <label className="modal-label">Category name</label>
              <input
                ref={firstInputRef}
                value={categoryName}
                onChange={e => setCategoryName(e.target.value.replace(/\s+/g, '_'))}
                placeholder="e.g. location, email, courses"
                required
              />
              <div className="modal-hint">Will appear as {`{{${categoryName || 'name'}}}`} in your template</div>
            </div>
          ) : (
            <div className="modal-field">
              <label className="modal-label">Category</label>
              <select
                ref={firstInputRef}
                className="vp-select"
                value={existingCat}
                onChange={e => setExistingCat(e.target.value)}
              >
                {existingCategories.map(c => (
                  <option key={c} value={c}>{`{{${c}}}`}</option>
                ))}
              </select>
              <div className="modal-hint">
                The selected text will be added as a new preset under this category.
                The template already has {`{{${existingCat}}}`} in it — no change to the template.
              </div>
            </div>
          )}

          <div className="modal-field">
            <label className="modal-label">Preset name</label>
            <input
              value={presetName}
              onChange={e => setPresetName(e.target.value.replace(/\s+/g, '_'))}
              placeholder="e.g. toronto, eu, school"
              required
            />
          </div>

          <div className="modal-actions">
            <button type="submit" className="btn-primary">Create</button>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
