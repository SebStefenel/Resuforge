// Turning a LaTeX resume into something worth handing a model.
//
// The editor holds a LaTeX document with variant placeholders in it. Sending
// that verbatim would spend a large share of the tokens on \documentclass,
// \begin{itemize}, spacing tweaks and colour definitions — markup that cannot
// affect any judgement about whether a job suits the person. So the resume is
// resolved (variants substituted) and then reduced to the words.
//
// The stripping is deliberately lossy and deliberately simple. It is not a TeX
// parser and does not need to be: the goal is readable prose with the section
// headings and bullet structure intact, not a faithful re-render.
import { resolveTemplate } from './variants'

// Commands whose brace argument is NOT content. Everything else keeps its
// argument, and that default is the important one: resume templates are built
// out of custom macros — \heading{...}, \resumeSubheading{...}, \cvitem{...} —
// and a whitelist of known LaTeX commands silently deletes every job title in
// the document. Unknown command in the body: assume the braces hold words.
const DROP_ARG = new Set([
  'usepackage', 'documentclass', 'definecolor', 'newcommand', 'renewcommand',
  'providecommand', 'newenvironment', 'renewenvironment', 'setlength',
  'addtolength', 'setcounter', 'vspace', 'hspace', 'rule', 'includegraphics',
  'label', 'ref', 'pageref', 'cite', 'bibliography', 'bibliographystyle',
  'input', 'include', 'geometry', 'hypersetup', 'titleformat', 'titlespacing',
  'fontsize', 'selectfont', 'color', 'pagestyle', 'thispagestyle', 'fancyhead',
  'fancyfoot', 'titlerule', 'arrayrulecolor', 'rowcolor', 'columncolor',
])

// Whole environments that never carry resume content.
const DROP_ENV = /\\begin\{(comment|verbatim|filecontents\*?)\}[\s\S]*?\\end\{\1\}/g

export function latexToText(latex) {
  let s = String(latex || '')

  // Preamble is definitions, not content: start at the document body if there
  // is one.
  const body = s.indexOf('\\begin{document}')
  if (body !== -1) s = s.slice(body + '\\begin{document}'.length)
  s = s.replace(/\\end\{document\}[\s\S]*$/, '')

  s = s.replace(DROP_ENV, ' ')
  // Comments, but not an escaped \%.
  s = s.replace(/(^|[^\\])%.*$/gm, '$1')

  // \href{url}{label} and \url{...} — keep the label, drop the target.
  s = s.replace(/\\href\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, '$1')
  s = s.replace(/\\url\s*\{([^{}]*)\}/g, '$1')

  // Section headings become their own line so structure survives.
  s = s.replace(/\\(?:sub)*section\*?\s*\{([^{}]*)\}/g, '\n\n$1\n')
  s = s.replace(/\\item\b/g, '\n• ')

  // Environments: keep what's inside, drop the markers.
  s = s.replace(/\\(?:begin|end)\s*\{[^{}]*\}(\s*\[[^\]]*\])?(\s*\{[^{}]*\})*/g, '\n')

  // \textcolor{red}{words} and friends: the first argument is a colour, the
  // second is content.
  s = s.replace(/\\(?:textcolor|colorbox|fcolorbox)\s*(?:\{[^{}]*\}){1,2}\s*\{([^{}]*)\}/g, '$1')

  // Remaining commands: keep the argument unless the command is one whose
  // argument is configuration. Repeat, since these nest.
  for (let i = 0; i < 6; i++) {
    const before = s
    s = s.replace(/\\([A-Za-z@]+)\*?\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g, (m, cmd, _opt, arg) =>
      DROP_ARG.has(cmd) ? ' ' : arg)
    s = s.replace(/\\[A-Za-z@]+\*?\s*(\[[^\]]*\])?/g, ' ')
    if (s === before) break
  }

  s = s
    .replace(/[{}]/g, ' ')
    .replace(/\\\\|\\newline|\\par\b/g, '\n')
    .replace(/\\[&%$#_{}~^]/g, (m) => m[1]) // escaped literals
    .replace(/~/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')             // inline math is never resume prose
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return s
}

// A resume long enough to matter is a page or two; this is generous for that
// and stops a runaway document from dominating every screening request.
export const MAX_RESUME_CHARS = 6000

/**
 * Build the snapshot the WaterlooWorks section keeps. A snapshot rather than a
 * live reference on purpose: screening results should stay explainable against
 * the resume they were actually judged on, not silently re-interpreted every
 * time the editor changes.
 */
export function buildResumeContext({ resumeName, template, categories, selected, resumeId }) {
  const latex = resolveTemplate(template, categories, selected)
  const text = latexToText(latex)
  return {
    name: resumeName || 'resume',
    resumeId: resumeId || null,
    text: text.length > MAX_RESUME_CHARS ? text.slice(0, MAX_RESUME_CHARS) + '\n…' : text,
    chars: text.length,
    truncated: text.length > MAX_RESUME_CHARS,
    attachedAt: new Date().toISOString(),
  }
}
