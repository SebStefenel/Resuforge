import { useState, useCallback, useRef } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import './PdfViewer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url
).toString()

export default function PdfViewer({ url, onSyncClick }) {
  const [numPages, setNumPages] = useState(null)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.0)
  // Intrinsic page size in PDF points, needed to turn a click into the
  // coordinates SyncTeX expects (independent of zoom and device pixel ratio).
  const pageSize = useRef(null)

  const onLoadSuccess = useCallback(({ numPages }) => {
    setNumPages(numPages)
    setPage(1)
  }, [])

  const onPageLoadSuccess = useCallback((pdfPage) => {
    const vp = pdfPage.getViewport({ scale: 1 })
    pageSize.current = { width: vp.width, height: vp.height }
  }, [])

  // Translate a click on the rendered page into PDF points measured from the
  // top-left corner, which is the origin SyncTeX uses.
  const handleClick = useCallback((e) => {
    if (!onSyncClick || !pageSize.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const x = ((e.clientX - rect.left) / rect.width) * pageSize.current.width
    const y = ((e.clientY - rect.top) / rect.height) * pageSize.current.height
    onSyncClick(page, x, y)
  }, [onSyncClick, page])

  if (!url) {
    return (
      <div className="pdf-empty">
        <div className="pdf-empty-icon">⬡</div>
        <div>Click <strong>Recompile</strong> to generate a preview</div>
      </div>
    )
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-controls">
        <button
          className="btn-ghost"
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page <= 1}
        >‹</button>
        <span className="pdf-page-info">
          {page} / {numPages ?? '?'}
        </span>
        <button
          className="btn-ghost"
          onClick={() => setPage(p => Math.min(numPages ?? p, p + 1))}
          disabled={page >= (numPages ?? 1)}
        >›</button>
        <div className="pdf-scale">
          <button className="btn-ghost" onClick={() => setScale(s => Math.max(0.5, +(s - 0.1).toFixed(1)))}>−</button>
          <span>{Math.round(scale * 100)}%</span>
          <button className="btn-ghost" onClick={() => setScale(s => Math.min(2.5, +(s + 0.1).toFixed(1)))}>+</button>
        </div>
      </div>
      <div className="pdf-scroll">
        <Document
          file={url}
          onLoadSuccess={onLoadSuccess}
          loading={<div className="pdf-loading">Loading…</div>}
          error={<div className="pdf-error">Failed to load PDF</div>}
        >
          <div
            className={onSyncClick ? 'pdf-page-clickable' : undefined}
            onClick={handleClick}
            title={onSyncClick ? 'Click to jump to the LaTeX that produced this' : undefined}
          >
            <Page
              pageNumber={page}
              scale={scale}
              onLoadSuccess={onPageLoadSuccess}
              renderAnnotationLayer={false}
              renderTextLayer={false}
            />
          </div>
        </Document>
      </div>
    </div>
  )
}
