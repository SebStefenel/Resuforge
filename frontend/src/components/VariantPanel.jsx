import { useState } from 'react'
import './VariantPanel.css'

export default function VariantPanel({
  categories,
  selected,
  onSelectPreset,
  onAddPreset,
  onDeletePreset,
  onDeleteCategory,
  onRenamePreset,
  onUpdatePresetValue,
}) {
  const catNames = Object.keys(categories)

  if (catNames.length === 0) {
    return (
      <div className="vp-empty">
        <p>No variants yet.</p>
        <p>Select text in the editor and click <strong>+ Create Slot</strong> to begin.</p>
      </div>
    )
  }

  return (
    <div className="vp-list">
      {catNames.map(cat => (
        <Category
          key={cat}
          name={cat}
          data={categories[cat]}
          selectedPreset={selected[cat]}
          onSelectPreset={(p) => onSelectPreset(cat, p)}
          onAddPreset={(name, val) => onAddPreset(cat, name, val)}
          onDeletePreset={(p) => onDeletePreset(cat, p)}
          onDeleteCategory={() => onDeleteCategory(cat)}
          onRenamePreset={(o, n) => onRenamePreset(cat, o, n)}
          onUpdatePresetValue={(p, v) => onUpdatePresetValue(cat, p, v)}
        />
      ))}
    </div>
  )
}

function Category({
  name,
  data,
  selectedPreset,
  onSelectPreset,
  onAddPreset,
  onDeletePreset,
  onDeleteCategory,
  onRenamePreset,
  onUpdatePresetValue,
}) {
  const [open, setOpen] = useState(true)
  const [addingPreset, setAddingPreset] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [newPresetVal, setNewPresetVal] = useState('')
  const [editingPreset, setEditingPreset] = useState(null) // presetName being edited
  const [editVal, setEditVal] = useState('')
  const [editName, setEditName] = useState('')

  const presets = data?.presets ?? {}
  const presetNames = Object.keys(presets)

  function handleAdd() {
    const n = newPresetName.trim()
    const v = newPresetVal
    if (!n) return
    onAddPreset(n, v)
    setNewPresetName('')
    setNewPresetVal('')
    setAddingPreset(false)
  }

  function startEdit(presetName) {
    setEditingPreset(presetName)
    setEditName(presetName)
    setEditVal(presets[presetName])
  }

  function commitEdit() {
    if (editName.trim() && editName !== editingPreset) {
      onRenamePreset(editingPreset, editName.trim())
    }
    onUpdatePresetValue(editName.trim() || editingPreset, editVal)
    setEditingPreset(null)
  }

  return (
    <div className="vp-category">
      <div className="vp-cat-header" onClick={() => setOpen(o => !o)}>
        <span className="vp-cat-chevron">{open ? '▾' : '▸'}</span>
        <span className="vp-cat-name">
          <span className="vp-cat-slug">{'{{' + name + '}}'}</span>
        </span>
        <button
          className="btn-danger vp-cat-delete"
          onClick={(e) => { e.stopPropagation(); onDeleteCategory() }}
          title="Delete this category (removes {{placeholder}} from template)"
        >✕</button>
      </div>

      {open && (
        <div className="vp-cat-body">
          {/* Active preset selector */}
          <div className="vp-active-row">
            <span className="vp-active-label">Active</span>
            <select
              className="vp-select"
              value={selectedPreset ?? ''}
              onChange={e => onSelectPreset(e.target.value)}
            >
              {presetNames.length === 0 && <option value="">—</option>}
              {presetNames.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Preset list */}
          <div className="vp-presets">
            {presetNames.map(p => (
              <div key={p} className={`vp-preset ${selectedPreset === p ? 'vp-preset--active' : ''}`}>
                {editingPreset === p ? (
                  <div className="vp-edit-form">
                    <input
                      className="vp-input"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder="Preset name"
                    />
                    <textarea
                      className="vp-textarea"
                      value={editVal}
                      onChange={e => setEditVal(e.target.value)}
                      rows={3}
                      placeholder="Value (what goes in the template)"
                    />
                    <div className="vp-edit-actions">
                      <button className="btn-primary" onClick={commitEdit}>Save</button>
                      <button className="btn-ghost" onClick={() => setEditingPreset(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="vp-preset-row">
                    <div
                      className="vp-preset-info"
                      onClick={() => onSelectPreset(p)}
                    >
                      <span className="vp-preset-name">{p}</span>
                      <span className="vp-preset-val">{presets[p]}</span>
                    </div>
                    <div className="vp-preset-actions">
                      <button className="btn-ghost" onClick={() => startEdit(p)}>✎</button>
                      <button className="btn-danger" onClick={() => onDeletePreset(p)}>✕</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add preset */}
          {addingPreset ? (
            <div className="vp-add-form">
              <input
                className="vp-input"
                value={newPresetName}
                onChange={e => setNewPresetName(e.target.value)}
                placeholder="Preset name (e.g. toronto)"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
              <textarea
                className="vp-textarea"
                value={newPresetVal}
                onChange={e => setNewPresetVal(e.target.value)}
                rows={3}
                placeholder="Value (what goes in the template)"
              />
              <div className="vp-add-actions">
                <button className="btn-primary" onClick={handleAdd}>Add</button>
                <button className="btn-ghost" onClick={() => setAddingPreset(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn-ghost vp-add-btn" onClick={() => setAddingPreset(true)}>
              + Add preset
            </button>
          )}
        </div>
      )}
    </div>
  )
}
