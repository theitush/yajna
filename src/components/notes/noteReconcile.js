/**
 * A tag-note's document, as pure functions: how `noteDocument(...)` entries
 * become the html one editor is loaded with, and how the editor's blocks come
 * back as the blocks the note stores.
 *
 * The note is one document (#48). Its stored blocks keep the order the writer
 * left them in; the paragraphs a tag has captured that the note has not placed
 * yet trail at the end. Every captured paragraph on screen is a MIRROR
 * (data-origin + data-mirror: shows the live source) until the writer edits
 * it, at which point the note takes its own copy — a FORK, same origin, no
 * mirror flag — and the source is left exactly as it was. Own writing carries
 * no provenance at all and is stored as typed, where it was typed.
 *
 * READ-ONLY TOWARDS THE JOURNAL BY CONSTRUCTION: this module imports no writer
 * at all. The only thing it returns is a note's own blocks and hiddenOrigins.
 *
 * No DOM here — `docBlocks` and the baseline are both produced by docToBlocks
 * in the browser, which is what makes the fork test exact: baseline html is
 * whatever the editor itself serialized right after the document was rendered,
 * so an untouched block compares byte-equal and is never forked by accident.
 */
import { originOf } from '../../lib/tagIndex.js'

export const PROVENANCE_ATTRS = ['data-origin', 'data-src', 'data-date', 'data-mirror']

/**
 * Index of the `>` that closes the first tag in `html`, honouring quoted
 * attribute values — an audio block's data-transcript legitimately contains
 * `>`, and a naive scan to the first `>` would cut the tag in half.
 */
function firstTagEnd(html) {
  const start = html.indexOf('<')
  if (start < 0) return -1
  let quote = null
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '>') return i
  }
  return -1
}

function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * Set attributes on a block's outer tag, in place when they already exist;
 * a `false` value removes the attribute, `null`/`undefined` leaves it alone.
 * Idempotent: re-applying the same values returns the identical string, which
 * is what lets a stored block round-trip through the editor without churning.
 */
export function setBlockAttrs(html, attrs) {
  if (!html) return html
  const end = firstTagEnd(html)
  if (end < 0) return html
  let head = html.slice(0, end)
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null) continue
    const re = new RegExp(`\\s${name}="[^"]*"`)
    if (value === false) {
      head = head.replace(re, '')
      continue
    }
    const next = ` ${name}="${escapeAttr(value)}"`
    head = re.test(head) ? head.replace(re, next) : head + next
  }
  return head + html.slice(end)
}

/** A block's html with every provenance attribute removed: own writing. */
export function stripProvenance(html) {
  return setBlockAttrs(html, Object.fromEntries(PROVENANCE_ATTRS.map(a => [a, false])))
}

/**
 * A block's html with the outer tag's attributes sorted, for COMPARISON only.
 * ProseMirror emits attributes in schema order while setBlockAttrs appends the
 * ones a source block didn't have, so the same content can serialize two ways.
 * Comparing normalized forms keeps the re-render effect from calling
 * setContent (and resetting the caret) on the echo of the note's own save.
 * Never stored — storage always keeps the editor's own serialization.
 */
export function normalizeBlockHtml(html) {
  if (!html) return ''
  const end = firstTagEnd(html)
  if (end < 0) return html
  const head = html.slice(0, end)
  const m = /^<([a-zA-Z][\w-]*)/.exec(head)
  if (!m) return html
  const attrs = [...head.slice(m[0].length).matchAll(/\s+([^\s=]+)="([^"]*)"/g)]
    .map(a => `${a[1]}="${a[2]}"`)
    .sort()
  return `<${m[1]}${attrs.length ? ' ' + attrs.join(' ') : ''}${html.slice(end)}`
}

/** True when a block holds nothing a person typed or recorded. */
export function isBlankHtml(html) {
  if (!html) return true
  if (/data-audio-id=/.test(html)) return false
  if (/<(img|video|hr|iframe)\b/i.test(html)) return false
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === ''
}

/** `journal:2026-09-01` | `note:<id>` for a captured entry. */
export function entrySrc(entry) {
  if (!entry?.srcType || !entry?.srcId) return null
  return `${entry.srcType}:${entry.srcId}`
}

/** The html one entry renders as: own writing verbatim, a captured block with its provenance on the tag. */
export function renderEntryHtml(e) {
  if (e.kind === 'own') return e.html || ''
  return setBlockAttrs(e.html || '', {
    'data-bid': e.origin,
    'data-origin': e.origin,
    'data-src': entrySrc(e),
    'data-date': e.date,
    'data-mirror': e.kind === 'mirror' ? '1' : false,
  })
}

/** The html the note editor is loaded with. */
export function renderNoteHtml(entries) {
  return (entries || []).map(renderEntryHtml).join('')
}

/**
 * True when the editor already shows exactly these entries — same blocks in
 * the same order, same content up to attribute order. `docBlocks` comes from
 * docToBlocks over the live doc.
 */
export function docMatchesEntries(docBlocks, entries) {
  const blocks = docBlocks || []
  const list = entries || []
  if (list.length === 0) {
    // An empty note renders as '', which ProseMirror fills with one empty
    // paragraph — that is a match, not a pending change.
    return blocks.length === 0 || (blocks.length === 1 && isBlankHtml(blocks[0].html))
  }
  if (blocks.length !== list.length) return false
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    const key = e.kind === 'own' ? blocks[i].id : (originOf(blocks[i]) || blocks[i].id)
    if (key !== e.id) return false
    if (normalizeBlockHtml(blocks[i].html) !== normalizeBlockHtml(renderEntryHtml(e))) return false
  }
  return true
}

/**
 * The baseline the reconcile compares against: what the editor serialized the
 * moment the document was rendered, keyed by origin, for the CAPTURED blocks
 * only. Own writing has no baseline — it is stored as it is, always.
 */
export function buildBaseline(docBlocks, entries) {
  const byOrigin = new Map((entries || []).filter(e => e.kind !== 'own').map(e => [e.origin, e]))
  const out = new Map()
  for (const b of docBlocks || []) {
    const origin = originOf(b)
    const entry = byOrigin.get(origin)
    if (!entry) continue
    out.set(origin, {
      html: b.html || '',
      src: entrySrc(entry),
      date: entry.date,
      isFork: entry.kind === 'fork',
    })
  }
  return out
}

/**
 * Reconcile the editor's blocks against the baseline: what the note stores.
 *
 *   - a block with no data-origin is own writing → stored as typed, where it
 *     sits (a blank line included — it is a spacer the writer kept);
 *   - a captured block whose html equals its baseline → stored as a MIRROR:
 *     this is what fixes a newly arrived paragraph's place in the note, and a
 *     mirror keeps following its source;
 *   - a captured block whose html changed, or that was already a fork → the
 *     note's own copy, keyed by the origin, the mirror flag gone;
 *   - a captured block whose origin is not in the baseline, or is the second
 *     block claiming an origin (a paste, the tail of a split) → own writing
 *     under its own id, provenance stripped;
 *   - a captured block the writer removed → its origin joins hiddenOrigins, so
 *     it does not come back from the derived tail (the source keeps it — #9).
 *
 * Returns { blocks: [{ id, html }], hiddenOrigins: string[] }.
 */
export function reconcileNote({ baseline, docBlocks, hiddenOrigins = [] }) {
  const base = baseline || new Map()
  const seen = new Set()
  const blocks = []

  for (const b of docBlocks || []) {
    const html = b.html || ''
    const origin = /\sdata-origin="/.test(html) ? originOf(b) : null
    if (!origin) {
      blocks.push({ id: b.id, html })
      continue
    }
    const entry = base.get(origin)
    if (!entry || seen.has(origin)) {
      blocks.push({ id: b.id, html: stripProvenance(html) })
      continue
    }
    seen.add(origin)
    const changed = html !== entry.html
    if (!changed && !entry.isFork) {
      blocks.push({ id: origin, html: entry.html })
      continue
    }
    blocks.push({
      id: origin,
      html: setBlockAttrs(html, {
        'data-bid': origin,
        'data-origin': origin,
        'data-src': entry.src,
        'data-date': entry.date,
        'data-mirror': false,
      }),
    })
  }

  const hidden = new Set((hiddenOrigins || []).filter(o => !seen.has(o)))
  for (const origin of base.keys()) if (!seen.has(origin)) hidden.add(origin)
  return { blocks, hiddenOrigins: [...hidden] }
}
