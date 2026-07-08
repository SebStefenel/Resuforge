import { useState, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import './PdfViewer.css'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url
).toString()

export default function PdfViewer({ url }) {
  const [numPages, setNumPages] = useState(null)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.0)

  const onLoadSuccess = useCallback(({ numPages }) => {
    setNumPages(numPages)
    setPage(1)
  }, [])

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
          <Page
            pageNumber={page}
            scale={scale}
            renderAnnotationLayer={false}
            renderTextLayer={false}
          />
        </Document>
      </div>
    </div>
  )
}
