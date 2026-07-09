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
  const [slotType, setSlotType] = useState('single') // for new categories
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

  const isDerived = mode === 'new' && slotType === 'derived'

  function handleSubmit(e) {
    e.preventDefault()
    const cat = mode === 'new' ? categoryName.trim() : existingCat
    if (!cat) return
    const preset = presetName.trim()
    // Derived slots are computed from tags — no preset value to name.
    if (!isDerived && !preset) return

    onCreate({
      categoryName: cat,
      presetName: preset,
      value: selectedText,
      from,
      to,
      type: mode === 'new' ? slotType : undefined,
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
          <div className="modal-label">
            {isDerived
              ? 'Selected text (will be replaced by the computed list)'
              : 'Selected text (will become the preset value)'}
          </div>
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
          ) : null}

          {mode === 'new' && (
            <div className="modal-field">
              <label className="modal-label">Slot type</label>
              <select className="vp-select" value={slotType} onChange={e => setSlotType(e.target.value)}>
                <option value="single">Single — pick one preset</option>
                <option value="multi">Multi — pick several presets</option>
                <option value="derived">Derived — computed from other slots' tags</option>
              </select>
              <div className="modal-hint">
                {slotType === 'single' && 'A normal swappable value.'}
                {slotType === 'multi' && 'Insert several presets at once (e.g. any 2 projects). Configure the count in the panel.'}
                {slotType === 'derived' && 'No presets — it aggregates tags from other slots (e.g. skills from selected projects). Configure sources in the panel.'}
              </div>
            </div>
          )}

          {mode === 'existing' && (
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

          {!isDerived && (
            <div className="modal-field">
              <label className="modal-label">Preset name</label>
              <input
                value={presetName}
                onChange={e => setPresetName(e.target.value.replace(/\s+/g, '_'))}
                placeholder="e.g. toronto, eu, school"
              />
            </div>
          )}

          <div className="modal-actions">
            <button type="submit" className="btn-primary">Create</button>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
