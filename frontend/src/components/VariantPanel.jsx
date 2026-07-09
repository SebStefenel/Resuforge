import { useState } from 'react'
import { categoryValue, computeDerivedTags } from '../lib/variants'
import './VariantPanel.css'

export default function VariantPanel(props) {
  const { categories } = props
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
        <Category key={cat} name={cat} {...props} />
      ))}
    </div>
  )
}

function Category({
  name, categories, selected,
  onSelectPreset, onToggleMultiPick,
  onAddPreset, onDeletePreset, onDeleteCategory, onRenamePreset, onUpdatePresetValue,
  onSetPresetTags, onSetCategoryType, onSetCategoryConfig, onAddVocab, onRemoveVocab,
}) {
  const data = categories[name]
  const [open, setOpen] = useState(true)
  const [addingPreset, setAddingPreset] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [newPresetVal, setNewPresetVal] = useState('')
  const [editingPreset, setEditingPreset] = useState(null)
  const [editVal, setEditVal] = useState('')
  const [editName, setEditName] = useState('')
  const [newVocab, setNewVocab] = useState('')

  const type = data.type
  const presets = data.presets ?? {}
  const presetNames = Object.keys(presets)
  const picks = Array.isArray(selected[name]) ? selected[name] : []

  function handleAdd() {
    const n = newPresetName.trim()
    if (!n) return
    onAddPreset(name, n, newPresetVal)
    setNewPresetName(''); setNewPresetVal(''); setAddingPreset(false)
  }
  function startEdit(p) {
    setEditingPreset(p); setEditName(p); setEditVal(presets[p].latex)
  }
  function commitEdit() {
    if (editName.trim() && editName !== editingPreset) onRenamePreset(name, editingPreset, editName.trim())
    onUpdatePresetValue(name, editName.trim() || editingPreset, editVal)
    setEditingPreset(null)
  }
  function toggleTag(p, term) {
    const cur = presets[p].tags
    const next = cur.includes(term) ? cur.filter(t => t !== term) : [...cur, term]
    onSetPresetTags(name, p, next)
  }

  return (
    <div className="vp-category">
      <div className="vp-cat-header" onClick={() => setOpen(o => !o)}>
        <span className="vp-cat-chevron">{open ? '▾' : '▸'}</span>
        <span className="vp-cat-name"><span className="vp-cat-slug">{'{{' + name + '}}'}</span></span>
        <span className="vp-cat-type">{type}</span>
        <button
          className="btn-danger vp-cat-delete"
          onClick={(e) => { e.stopPropagation(); onDeleteCategory(name) }}
          title="Delete this category (removes its placeholder from the template)"
        >✕</button>
      </div>

      {open && (
        <div className="vp-cat-body">
          {/* Type selector */}
          <div className="vp-row">
            <span className="vp-row-label">Type</span>
            <select className="vp-select" value={type} onChange={e => onSetCategoryType(name, e.target.value)}>
              <option value="single">Single (pick one)</option>
              <option value="multi">Multi (pick several)</option>
              <option value="derived">Derived (computed from tags)</option>
            </select>
          </div>

          {type === 'derived' ? (
            <DerivedConfig
              name={name} data={data} categories={categories} selected={selected}
              onSetCategoryConfig={onSetCategoryConfig}
            />
          ) : (
            <>
              {type === 'single' ? (
                <div className="vp-row">
                  <span className="vp-row-label">Active</span>
                  <select
                    className="vp-select"
                    value={selected[name] ?? ''}
                    onChange={e => onSelectPreset(name, e.target.value)}
                  >
                    {presetNames.length === 0 && <option value="">—</option>}
                    {presetNames.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              ) : (
                <div className="vp-row">
                  <span className="vp-row-label">Pick</span>
                  <input
                    className="vp-count-input"
                    type="number" min="1" max={Math.max(1, presetNames.length)}
                    value={data.selectCount}
                    onChange={e => onSetCategoryConfig(name, { selectCount: Math.max(1, parseInt(e.target.value) || 1) })}
                  />
                  <span className="vp-row-hint">
                    of {presetNames.length} — {picks.length} ticked for preview
                  </span>
                </div>
              )}

              {/* Preset list */}
              <div className="vp-presets">
                {presetNames.map(p => (
                  <div key={p} className={`vp-preset ${isActive(type, selected[name], p) ? 'vp-preset--active' : ''}`}>
                    {editingPreset === p ? (
                      <div className="vp-edit-form">
                        <input className="vp-input" value={editName} onChange={e => setEditName(e.target.value)} placeholder="Preset name" />
                        <textarea className="vp-textarea" value={editVal} onChange={e => setEditVal(e.target.value)} rows={3} placeholder="LaTeX value" />
                        <div className="vp-edit-actions">
                          <button className="btn-primary" onClick={commitEdit}>Save</button>
                          <button className="btn-ghost" onClick={() => setEditingPreset(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="vp-preset-row">
                          {type === 'multi' && (
                            <input
                              type="checkbox"
                              className="vp-check"
                              checked={picks.includes(p)}
                              onChange={() => onToggleMultiPick(name, p)}
                              title="Include in preview"
                            />
                          )}
                          <div
                            className="vp-preset-info"
                            onClick={() => type === 'single' ? onSelectPreset(name, p) : onToggleMultiPick(name, p)}
                          >
                            <span className="vp-preset-name">{p}</span>
                            <span className="vp-preset-val">{presets[p].latex}</span>
                          </div>
                          <div className="vp-preset-actions">
                            <button className="btn-ghost" onClick={() => startEdit(p)}>✎</button>
                            <button className="btn-danger" onClick={() => onDeletePreset(name, p)}>✕</button>
                          </div>
                        </div>
                        {data.vocabulary.length > 0 && (
                          <div className="vp-tagrow">
                            {data.vocabulary.map(term => (
                              <button
                                key={term}
                                className={`vp-tag ${presets[p].tags.includes(term) ? 'vp-tag--on' : ''}`}
                                onClick={() => toggleTag(p, term)}
                                title="Toggle this tag for this preset"
                              >{term}</button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* Add preset */}
              {addingPreset ? (
                <div className="vp-add-form">
                  <input className="vp-input" value={newPresetName} onChange={e => setNewPresetName(e.target.value)} placeholder="Preset name (e.g. toronto)" autoFocus onKeyDown={e => e.key === 'Enter' && handleAdd()} />
                  <textarea className="vp-textarea" value={newPresetVal} onChange={e => setNewPresetVal(e.target.value)} rows={3} placeholder="LaTeX value" />
                  <div className="vp-add-actions">
                    <button className="btn-primary" onClick={handleAdd}>Add</button>
                    <button className="btn-ghost" onClick={() => setAddingPreset(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="btn-ghost vp-add-btn" onClick={() => setAddingPreset(true)}>+ Add preset</button>
              )}

              {/* Vocabulary (tags) editor */}
              <div className="vp-vocab">
                <div className="vp-vocab-title">Tags / skills vocabulary</div>
                <div className="vp-vocab-chips">
                  {data.vocabulary.map(term => (
                    <span key={term} className="vp-vocab-chip">
                      {term}
                      <button className="vp-vocab-x" onClick={() => onRemoveVocab(name, term)} title="Remove tag">×</button>
                    </span>
                  ))}
                  {data.vocabulary.length === 0 && <span className="vp-row-hint">none yet</span>}
                </div>
                <div className="vp-vocab-add">
                  <input
                    className="vp-input" value={newVocab} onChange={e => setNewVocab(e.target.value)}
                    placeholder="Add a tag (e.g. Python)"
                    onKeyDown={e => { if (e.key === 'Enter') { onAddVocab(name, newVocab); setNewVocab('') } }}
                  />
                  <button className="btn-ghost" onClick={() => { onAddVocab(name, newVocab); setNewVocab('') }}>Add</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function isActive(type, sel, preset) {
  if (type === 'multi') return Array.isArray(sel) && sel.includes(preset)
  return sel === preset
}

function DerivedConfig({ name, data, categories, selected, onSetCategoryConfig }) {
  // Candidate source categories: those that carry a vocabulary/tags.
  const candidates = Object.keys(categories).filter(
    c => c !== name && (categories[c].type === 'single' || categories[c].type === 'multi')
  )
  const preview = categoryValue(categories, selected, name)
  const tags = computeDerivedTags(categories, selected, data)

  function toggleSource(src) {
    const next = data.sources.includes(src) ? data.sources.filter(s => s !== src) : [...data.sources, src]
    onSetCategoryConfig(name, { sources: next })
  }

  return (
    <div className="vp-derived">
      <div className="vp-row-label vp-derived-label">Aggregate tags from</div>
      <div className="vp-source-list">
        {candidates.length === 0 && <span className="vp-row-hint">No taggable categories yet.</span>}
        {candidates.map(src => (
          <label key={src} className="vp-source">
            <input type="checkbox" checked={data.sources.includes(src)} onChange={() => toggleSource(src)} />
            <span>{'{{' + src + '}}'}</span>
          </label>
        ))}
      </div>

      <div className="vp-row">
        <span className="vp-row-label">Item</span>
        <input
          className="vp-input vp-mono" value={data.itemTemplate}
          onChange={e => onSetCategoryConfig(name, { itemTemplate: e.target.value })}
          placeholder="%s  or  \item %s"
        />
      </div>
      <div className="vp-row">
        <span className="vp-row-label">Join</span>
        <input
          className="vp-input vp-mono" value={data.joiner}
          onChange={e => onSetCategoryConfig(name, { joiner: e.target.value })}
          placeholder=", "
        />
      </div>
      <div className="vp-row-hint">%s is replaced by each tag; items are glued with “Join”. Use a literal newline in Join for a list.</div>

      <div className="vp-preview">
        <div className="vp-preview-title">Preview ({tags.length} tag{tags.length === 1 ? '' : 's'})</div>
        <pre className="vp-preview-body">{preview || '—'}</pre>
      </div>
    </div>
  )
}
