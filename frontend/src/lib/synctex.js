// Minimal SyncTeX reverse-search ("click the PDF, find the source line").
//
// Parsing happens once per compile and lookups run entirely in the browser, so
// clicking costs nothing and works even while the Fly machine is asleep.
//
// Format, briefly: a preamble of `Key:value` lines, then `Content:` followed by
// page blocks `{<n> … }`. Inside a page each record is a one-char type followed
// immediately by `tag,line[,column]:x,y[:width[,height,depth]]`:
//
//   ( )  hbox open/close      [ ]  vbox open/close
//   h v  void h/v box         k    kern      g  glue
//   x    current point        $    math
//
// `tag` identifies the source file via the preamble's `Input:` records — vital,
// because .cls and .sty files get their own tags and their line numbers are
// meaningless to us.

// TeX scaled points per PostScript big point: 65536 sp/pt × 72.27/72.
const SP_PER_BP = 65781.76

const RECORD = /^([[(hvxkg$])(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/

// Parse a .synctex file into { pages: Map<pageNumber, box[]> }.
// Each box is { line, x, y, w, h, d } in big points, y measured from the top of
// the page and anchored on the text baseline. Returns null if unusable.
export function parseSynctex(text) {
  if (!text || typeof text !== 'string') return null

  let unit = 1
  let magnification = 1000
  let xOffset = 0
  let yOffset = 0

  const inputs = new Map() // tag -> filename
  const lines = text.split('\n')

  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('Content:')) { i++; break }

    const input = /^Input:(\d+):(.*)$/.exec(l)
    if (input) { inputs.set(Number(input[1]), input[2]); continue }

    const kv = /^([\w ]+):(-?[\d.]+)$/.exec(l)
    if (!kv) continue
    const v = Number(kv[2])
    if (kv[1] === 'Unit') unit = v
    else if (kv[1] === 'Magnification') magnification = v
    else if (kv[1] === 'X Offset') xOffset = v
    else if (kv[1] === 'Y Offset') yOffset = v
  }

  // Only records from the document we compiled are useful; everything else is
  // a class/package file. server.js always writes the source as resume.tex.
  let mainTag = null
  for (const [tag, name] of inputs) {
    if (/resume\.tex$/.test(name)) { mainTag = tag; break }
  }
  // Fall back to the first .tex input so this still works if that name changes.
  if (mainTag == null) {
    for (const [tag, name] of inputs) {
      if (/\.tex$/.test(name)) { mainTag = tag; break }
    }
  }
  if (mainTag == null) return null

  const scale = (magnification / 1000) * unit
  const toBp = (n, offset) => (n * scale + offset) / SP_PER_BP

  const pages = new Map()
  let current = null

  for (; i < lines.length; i++) {
    const l = lines[i]
    if (!l) continue

    const ch = l[0]
    if (ch === '{') {
      const n = Number(l.slice(1))
      if (Number.isFinite(n)) { current = []; pages.set(n, current) }
      continue
    }
    if (ch === '}') { current = null; continue }
    if (!current) continue

    const m = RECORD.exec(l)
    if (!m || Number(m[2]) !== mainTag) continue

    current.push({
      // `[` and `(` open boxes that enclose other records — the page vbox
      // spans the whole text area, so it "contains" every click and would win
      // any nearest-match test. Only the leaf records identify actual content.
      leaf: ch !== '[' && ch !== '(',
      line: Number(m[3]),
      x: toBp(Number(m[4]), xOffset),
      y: toBp(Number(m[5]), yOffset),
      w: m[6] != null ? toBp(Number(m[6]), 0) : 0,
      h: m[7] != null ? toBp(Number(m[7]), 0) : 0,
      d: m[8] != null ? toBp(Number(m[8]), 0) : 0,
    })
  }

  if (pages.size === 0) return null
  return { pages }
}

// Squared distance from a point to a box's rectangle; 0 when inside.
function distanceTo(box, x, y) {
  // x,y is the baseline-left anchor: height extends up, depth down.
  const x1 = Math.min(box.x, box.x + box.w)
  const x2 = Math.max(box.x, box.x + box.w)
  const y1 = box.y - Math.max(0, box.h)
  const y2 = box.y + Math.max(0, box.d)

  const dx = x < x1 ? x1 - x : x > x2 ? x - x2 : 0
  const dy = y < y1 ? y1 - y : y > y2 ? y - y2 : 0
  return dx * dx + dy * dy
}

// Source line for a click at (x, y) in big points from the page's top-left.
//
// Considers only leaf records, matching what the `synctex` binary reports:
// a click just below a paragraph should resolve to that paragraph's line, not
// to the enclosing box (which is typically tagged with the blank line after it,
// or with \end{document} for the page vbox). Falls back to container boxes only
// if a page somehow has no leaves.
export function lookupLine(parsed, page, x, y) {
  const all = parsed?.pages?.get(page)
  if (!all || all.length === 0) return null

  const leaves = all.filter(b => b.leaf)
  const boxes = leaves.length > 0 ? leaves : all

  let best = null
  let bestDist = Infinity
  let bestArea = Infinity

  for (const box of boxes) {
    const dist = distanceTo(box, x, y)
    if (dist > bestDist) continue
    // Among equally close records prefer the tightest, which is the one
    // actually under the cursor rather than a wide glue/kern spanning the line.
    const area = Math.abs(box.w) * Math.max(0.01, Math.abs(box.h) + Math.abs(box.d))
    if (dist < bestDist || area < bestArea) {
      best = box
      bestDist = dist
      bestArea = area
    }
  }

  return best ? best.line : null
}
