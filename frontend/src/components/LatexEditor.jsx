import { forwardRef, useRef, useCallback, useEffect } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import './LatexEditor.css'

// Highlight {{placeholder}} tokens in the editor
function placeholderHighlighter(categories) {
  const mark = Decoration.mark({ class: 'cm-placeholder-token' })

  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = this.buildDecorations(view)
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view)
      }
    }
    buildDecorations(view) {
      const builder = new RangeSetBuilder()
      const text = view.state.doc.toString()
      const re = /\{\{([^}]+)\}\}/g
      let m
      while ((m = re.exec(text)) !== null) {
        builder.add(m.index, m.index + m[0].length, mark)
      }
      return builder.finish()
    }
  }, { decorations: v => v.decorations })
}

// Briefly flash the line jumped to from the PDF, so it's obvious where you
// landed. Driven by a StateEffect rather than a prop so repeat jumps to the
// same line still re-trigger it.
export const flashLine = StateEffect.define()
const clearFlash = StateEffect.define()

const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(flashLine)) {
        const line = tr.state.doc.lineAt(e.value)
        deco = Decoration.set([
          Decoration.line({ class: 'cm-sync-flash' }).range(line.from),
        ])
      } else if (e.is(clearFlash)) {
        deco = Decoration.none
      }
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})

// Move the cursor to `offset`, scroll it into view, and flash its line.
export function jumpToOffset(view, offset) {
  if (!view) return
  const pos = Math.max(0, Math.min(offset, view.state.doc.length))
  view.dispatch({
    selection: { anchor: pos },
    effects: [
      EditorView.scrollIntoView(pos, { y: 'center' }),
      flashLine.of(pos),
    ],
  })
  view.focus()
  setTimeout(() => {
    try { view.dispatch({ effects: clearFlash.of(null) }) } catch {}
  }, 1200)
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    background: 'var(--bg)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '12px',
  },
  '.cm-line': {
    color: 'var(--text)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--accent)',
  },
  '.cm-selectionBackground, ::selection': {
    background: 'rgba(26, 26, 26, 0.14) !important',
  },
  '.cm-gutters': {
    background: 'var(--surface)',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLineGutter': {
    background: 'var(--surface2)',
  },
  '.cm-activeLine': {
    background: 'rgba(0, 0, 0, 0.035)',
  },
  '.cm-placeholder-token': {
    background: 'rgba(26, 26, 26, 0.10)',
    color: 'var(--accent)',
    fontWeight: '600',
    borderRadius: '3px',
    padding: '0 2px',
  },
  '.cm-sync-flash': {
    background: 'rgba(255, 214, 0, 0.35)',
    transition: 'background 0.4s ease-out',
  },
})

const LatexEditor = forwardRef(function LatexEditor(
  { value, onChange, onRequestCreateSlot, categories },
  ref
) {
  const viewRef = useRef(null)

  const handleCreateSlot = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    const sel = view.state.selection.main
    if (sel.empty) {
      alert('Select some text in the editor first, then click "Create Slot".')
      return
    }
    const selectedText = view.state.doc.sliceString(sel.from, sel.to)
    onRequestCreateSlot(selectedText, sel.from, sel.to)
  }, [onRequestCreateSlot])

  return (
    <div className="latex-editor">
      <div className="latex-editor-toolbar">
        <button className="btn-primary" onClick={handleCreateSlot}>
          + Create Slot
        </button>
        <span className="toolbar-hint">Select text, then click to make it a variant</span>
      </div>
      <div className="latex-editor-cm">
        <CodeMirror
          value={value}
          onChange={onChange}
          height="100%"
          extensions={[
            editorTheme,
            EditorView.lineWrapping,
            placeholderHighlighter(categories),
            flashField,
          ]}
          onCreateEditor={(view) => {
            viewRef.current = view
            if (ref) ref.current = view
          }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            dropCursor: false,
            allowMultipleSelections: false,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            highlightActiveLine: true,
            highlightSelectionMatches: false,
          }}
        />
      </div>
    </div>
  )
})

export default LatexEditor
