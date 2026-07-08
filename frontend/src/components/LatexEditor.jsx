import { forwardRef, useRef, useCallback, useEffect } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
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

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    background: 'var(--bg)',
  },
  '.cm-scroller': {
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
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
    background: 'rgba(124, 106, 247, 0.3) !important',
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
    background: 'rgba(255,255,255,0.03)',
  },
  '.cm-placeholder-token': {
    background: 'rgba(124, 106, 247, 0.25)',
    color: 'var(--accent)',
    borderRadius: '3px',
    padding: '0 2px',
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
            placeholderHighlighter(categories),
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
