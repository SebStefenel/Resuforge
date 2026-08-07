// Shared variant logic — used by both the live compile and "Download All".
// Keeping it in one place guarantees the preview and the batch export resolve
// identically.
//
// Category shapes (after normalize):
//   single:  { type:'single', presets:{ name:{latex, tags:{group:[terms]}} }, groups:[{name,terms}] }
//   multi:   { type:'multi',  presets:{...}, groups:[...], selectCount:N, separator }
//   derived: { type:'derived', sources:[catName], group:'' , itemTemplate:'%s', joiner:', ' }
//
// Tags are organised into named groups (e.g. "Programming Languages",
// "Technologies"). A preset's tags is { [groupName]: [term, ...] }. A derived
// slot with group:'' unions every group; with group:'X' only that group.
//
// selection map:  { catName: presetName (single) | [presetNames] (multi) }

const DEFAULT_GROUP = 'Tags'

export function normalizePreset(p) {
  if (typeof p === 'string') return { latex: p, tags: {} }
  const raw = p?.tags
  let tags = {}
  if (Array.isArray(raw)) {
    // migrate flat tag list -> single default group
    if (raw.length) tags = { [DEFAULT_GROUP]: [...raw] }
  } else if (raw && typeof raw === 'object') {
    for (const [g, arr] of Object.entries(raw)) tags[g] = Array.isArray(arr) ? [...arr] : []
  }
  return { latex: typeof p?.latex === 'string' ? p.latex : '', tags }
}

export function normalizeCategory(cat) {
  const type = cat?.type === 'multi' || cat?.type === 'derived' ? cat.type : 'single'
  const presets = {}
  for (const [k, v] of Object.entries(cat?.presets ?? {})) presets[k] = normalizePreset(v)

  let groups
  if (Array.isArray(cat?.groups)) {
    groups = cat.groups.map(g => ({
      name: String(g?.name ?? ''),
      terms: Array.isArray(g?.terms) ? [...g.terms] : [],
    }))
  } else if (Array.isArray(cat?.vocabulary) && cat.vocabulary.length) {
    // migrate flat vocabulary -> single default group
    groups = [{ name: DEFAULT_GROUP, terms: [...cat.vocabulary] }]
  } else {
    groups = []
  }

  return {
    type,
    presets,
    groups,
    selectCount: Number.isInteger(cat?.selectCount) ? cat.selectCount : 2,
    separator: typeof cat?.separator === 'string' ? cat.separator : '\n\n',
    sources: Array.isArray(cat?.sources) ? cat.sources : [],
    group: typeof cat?.group === 'string' ? cat.group : '', // derived: which group to pull ('' = all)
    itemTemplate: typeof cat?.itemTemplate === 'string' ? cat.itemTemplate : '%s',
    joiner: typeof cat?.joiner === 'string' ? cat.joiner : ', ',
  }
}

export function normalizeCategories(categories) {
  const out = {}
  for (const [k, v] of Object.entries(categories ?? {})) out[k] = normalizeCategory(v)
  return out
}

// Which preset names are currently picked for a category, given a selection.
export function pickedPresetNames(cat, sel) {
  if (!cat) return []
  if (cat.type === 'multi') return Array.isArray(sel) ? sel.filter(n => cat.presets[n]) : []
  if (cat.type === 'single') return sel && cat.presets[sel] ? [sel] : []
  return []
}

// De-duplicated union of tags from a derived slot's sources, optionally
// filtered to a single group. Ordered by each source's vocabulary (group order,
// then term order) so output is stable; deduped first-seen across presets.
export function computeDerivedTags(categories, selection, derivedCat) {
  const wantGroup = derivedCat.group || ''
  const seen = new Set()
  const out = []
  for (const src of derivedCat.sources) {
    const sc = categories[src]
    if (!sc) continue
    for (const pn of pickedPresetNames(sc, selection[src])) {
      const presetTags = sc.presets[pn]?.tags ?? {}
      for (const group of sc.groups) {
        if (wantGroup && group.name !== wantGroup) continue
        const has = new Set(presetTags[group.name] ?? [])
        for (const term of group.terms) {
          if (has.has(term) && !seen.has(term)) { seen.add(term); out.push(term) }
        }
      }
    }
  }
  return out
}

// Group names available to a derived slot (union across its sources, in order).
export function derivedGroupNames(categories, derivedCat) {
  const names = []
  const seen = new Set()
  for (const src of derivedCat.sources) {
    for (const g of categories[src]?.groups ?? []) {
      if (!seen.has(g.name)) { seen.add(g.name); names.push(g.name) }
    }
  }
  return names
}

// The LaTeX a single category resolves to under a given selection.
export function categoryValue(categories, selection, name) {
  const cat = categories[name]
  if (!cat) return ''
  if (cat.type === 'single') {
    return cat.presets[selection[name]]?.latex ?? ''
  }
  if (cat.type === 'multi') {
    return pickedPresetNames(cat, selection[name])
      .map(pn => cat.presets[pn]?.latex ?? '')
      .join(cat.separator)
  }
  if (cat.type === 'derived') {
    return computeDerivedTags(categories, selection, cat)
      .map(t => cat.itemTemplate.split('%s').join(t))
      .join(cat.joiner)
  }
  return ''
}

// Replace every {{cat}} placeholder in the template with its resolved value.
export function resolveTemplate(template, categories, selection) {
  return resolveTemplateWithMap(template, categories, selection).text
}

// Same substitution as resolveTemplate, but also records where each piece of
// the output came from. SyncTeX reports line numbers in the *resolved*
// document while the editor shows the *template*, so click-to-source needs a
// way back.
//
// This walks a segment list instead of a flat string, applying the same
// per-category passes in the same order, so the concatenated output is
// byte-identical to the old implementation — including the case where one
// category's value contains another's placeholder.
//
// Returns { text, segments }, each segment:
//   { resStart, resEnd, tplStart, tplEnd, category }
// `category` is null for literal template text, which maps back 1:1. For
// injected variant content it names the slot, and tplStart/tplEnd bracket the
// {{placeholder}} — there's no finer-grained position to point at, since that
// text doesn't exist in the template.
export function resolveTemplateWithMap(template, categories, selection) {
  let segs = [{ text: template, tplStart: 0, tplEnd: template.length, category: null }]

  for (const name of Object.keys(categories)) {
    const token = `{{${name}}}`
    const value = categoryValue(categories, selection, name)
    const next = []

    for (const seg of segs) {
      if (!seg.text.includes(token)) { next.push(seg); continue }

      // Pieces of an injected segment stay attributed to their outer slot;
      // only literal segments carry real template offsets.
      const literal = seg.category === null
      const parts = seg.text.split(token)
      let cursor = 0

      parts.forEach((part, idx) => {
        if (idx > 0) {
          next.push({
            text: value,
            tplStart: literal ? seg.tplStart + cursor : seg.tplStart,
            tplEnd: literal ? seg.tplStart + cursor + token.length : seg.tplEnd,
            category: literal ? name : seg.category,
          })
          cursor += token.length
        }
        if (part) {
          next.push({
            text: part,
            tplStart: literal ? seg.tplStart + cursor : seg.tplStart,
            tplEnd: literal ? seg.tplStart + cursor + part.length : seg.tplEnd,
            category: seg.category,
          })
          cursor += part.length
        }
      })
    }
    segs = next
  }

  let text = ''
  const segments = []
  for (const seg of segs) {
    segments.push({
      resStart: text.length,
      resEnd: text.length + seg.text.length,
      tplStart: seg.tplStart,
      tplEnd: seg.tplEnd,
      category: seg.category,
    })
    text += seg.text
  }

  return { text, segments }
}

// Character offset in `text` where 1-based `line` starts.
export function offsetOfLine(text, line) {
  if (line <= 1) return 0
  let offset = 0
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', offset)
    if (nl === -1) return offset
    offset = nl + 1
  }
  return offset
}

// Map a 1-based line in the resolved document back to a position in the
// template. Returns { offset, category } — `category` is set when the line came
// from injected variant content, in which case `offset` points at its
// {{placeholder}}. Returns null if it can't be resolved.
export function mapResolvedLineToTemplate(resolved, resolvedLine) {
  const { text, segments } = resolved
  if (!segments || segments.length === 0) return null

  const target = offsetOfLine(text, resolvedLine)

  for (const seg of segments) {
    if (target >= seg.resStart && target < seg.resEnd) {
      if (seg.category !== null) return { offset: seg.tplStart, category: seg.category }
      return { offset: seg.tplStart + (target - seg.resStart), category: null }
    }
  }

  // Past the last segment (e.g. trailing newline) — fall back to its end.
  const last = segments[segments.length - 1]
  return { offset: last.category !== null ? last.tplStart : last.tplEnd, category: last.category }
}

// All k-combinations (order-independent) of an array.
export function combinations(arr, k) {
  const res = []
  if (k < 0 || k > arr.length) return res
  const combo = []
  const bt = (start) => {
    if (combo.length === k) { res.push(combo.slice()); return }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]); bt(i + 1); combo.pop()
    }
  }
  bt(0)
  return res
}

// Categories that participate in Download All enumeration: single/multi slots
// with at least one preset whose placeholder is present in the template.
export function enumerationCategories(template, categories) {
  return Object.keys(categories).filter(name => {
    const c = categories[name]
    if (c.type !== 'single' && c.type !== 'multi') return false
    if (Object.keys(c.presets).length === 0) return false
    return template.includes(`{{${name}}}`)
  })
}

// Options for one category: an array of "picks", each pick an array of preset names.
export function categoryOptions(cat) {
  const names = Object.keys(cat.presets)
  if (cat.type === 'single') return names.map(n => [n])
  if (cat.type === 'multi') return combinations(names, cat.selectCount)
  return []
}

// How many résumés Download All will produce (0 if nothing varies or a multi
// slot's selectCount exceeds its preset count).
export function combinationCount(template, categories) {
  const cats = enumerationCategories(template, categories)
  if (cats.length === 0) return 0
  let n = 1
  for (const name of cats) n *= categoryOptions(categories[name]).length
  return n
}

// Every combination as { selection, parts }, where parts drives folder naming.
export function enumerateSelections(template, categories) {
  const cats = enumerationCategories(template, categories)
  let combos = [{ selection: {}, parts: [] }]
  for (const name of cats) {
    const cat = categories[name]
    const opts = categoryOptions(cat)
    const next = []
    for (const base of combos) {
      for (const pick of opts) {
        next.push({
          selection: { ...base.selection, [name]: cat.type === 'single' ? pick[0] : pick },
          parts: [...base.parts, { name, pick }],
        })
      }
    }
    combos = next
  }
  return combos
}

// Filesystem/zip-safe path segment.
export function safeSeg(s) {
  return String(s).replace(/[^a-zA-Z0-9_.\- ]/g, '_').trim() || '_'
}

// Folder path for a combination, per layout ('nested' | 'flat').
export function comboFolder(parts, layout) {
  if (parts.length === 0) return 'resumes'
  const segs = parts.map(p => `${safeSeg(p.name)}:${p.pick.map(safeSeg).join('+')}`)
  return layout === 'flat' ? `resumes/${segs.join('__')}` : 'resumes/' + segs.join('/')
}
