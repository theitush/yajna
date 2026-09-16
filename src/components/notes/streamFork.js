/**
 * The stream editor's fork rule, as pure functions.
 *
 * Region B of a tag-note ("From the journal") shows `noteStream(...)` — blocks
 * DERIVED from every journal day and note that mentions the tag. Editing one
 * there must never touch its source: the note takes its own copy instead (a
 * "fork"), stored as a note block whose html carries data-origin / data-src /
 * data-date (see src/lib/tagIndex.js). Everything the user did NOT edit stays
 * derived and is never stored, so the stream keeps mirroring its source.
 *
 * READ-ONLY TOWARDS THE JOURNAL BY CONSTRUCTION: this module imports no writer
 * at all. The only thing it returns is a note's own blocks and hiddenOrigins.
 *
 * No DOM here — `docBlocks` and the baseline are both produced by docToBlocks
 * in the browser, which is what makes the comparison exact: baseline html is
 * whatever the editor itself serialized right after the stream was rendered,
 * so an untouched block compares byte-equal and is never forked by accident.
 */
import { originOf } from '../../lib/tagIndex.js'

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
 * Set attributes on a block's outer tag, in place when they already exist.
 * Idempotent: re-applying the same values returns the identical string, which
 * is what lets a stored fork round-trip through the editor without churning.
 */
export function setBlockAttrs(html, attrs) {
  if (!html) return html
  const end = firstTagEnd(html)
  if (end < 0) return html
  let head = html.slice(0, end)
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null) continue
    const re = new RegExp(`\\s${name}="[^"]*"`)
    const next = ` ${name}="${escapeAttr(value)}"`
    head = re.test(head) ? head.replace(re, next) : head + next
  }
  return head + html.slice(end)
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

/** `journal:2026-09-01` | `note:<id>` for a stream entry. */
export function entrySrc(entry) {
  if (!entry?.srcType || !entry?.srcId) return null
  return `${entry.srcType}:${entry.srcId}`
}

/**
 * The html the stream editor is loaded with: each entry's block, carrying its
 * origin as data-bid (identity is the origin block, #9) plus the provenance
 * attrs BlockIdExtension round-trips.
 */
export function renderStreamHtml(entries) {
  return (entries || []).map(e => setBlockAttrs(e.html || '', {
    'data-bid': e.origin,
    'data-origin': e.origin,
    'data-src': entrySrc(e),
    'data-date': e.date,
  })).join('')
}

/**
 * True when the editor already shows exactly these entries — same origins in
 * the same order, same content up to attribute order. `docBlocks` comes from
 * docToBlocks over the live doc.
 */
export function streamMatchesEntries(docBlocks, entries) {
  const blocks = docBlocks || []
  const list = entries || []
  if (list.length === 0) {
    // An empty stream renders as '', which ProseMirror fills with one empty
    // paragraph — that is a match, not a pending change.
    return blocks.length === 0 || (blocks.length === 1 && isBlankHtml(blocks[0].html))
  }
  if (blocks.length !== list.length) return false
  for (let i = 0; i < list.length; i++) {
    if ((originOf(blocks[i]) || blocks[i].id) !== list[i].origin) return false
    const rendered = setBlockAttrs(list[i].html || '', {
      'data-bid': list[i].origin,
      'data-origin': list[i].origin,
      'data-src': entrySrc(list[i]),
      'data-date': list[i].date,
    })
    if (normalizeBlockHtml(blocks[i].html) !== normalizeBlockHtml(rendered)) return false
  }
  return true
}

/**
 * The baseline the reconcile compares against: what the editor serialized the
 * moment the stream was rendered, keyed by origin. Blocks that are not part of
 * the stream (the trailing empty paragraph, anything typed since) are left out
 * on purpose — a block with no baseline is new writing, not a captured one.
 */
export function buildBaseline(docBlocks, entries) {
  const byOrigin = new Map((entries || []).map(e => [e.origin, e]))
  const out = new Map()
  for (const b of docBlocks || []) {
    const origin = originOf(b) || b.id
    const entry = byOrigin.get(origin)
    if (!entry) continue
    out.set(origin, {
      html: b.html || '',
      src: entrySrc(entry),
      date: entry.date,
      isFork: !!entry.isFork,
    })
  }
  return out
}

/**
 * Reconcile the stream doc against its baseline.
 *
 *   - html equal to its source and not already held → nothing stored;
 *   - html changed → the note stores its own copy, keyed by the origin;
 *   - a block the note already holds → kept, even untouched (dropping it
 *     would tombstone the fork and silently un-edit it);
 *   - a block typed straight into the stream → stored as its own origin,
 *     data-src `note:<id>`, dated today;
 *   - a stream block the user removed → its origin joins hiddenOrigins, so the
 *     derived stream stops showing it (the source keeps it — #9).
 *
 * A pasted copy of a stream block arrives with the same data-origin and a
 * fresh data-bid; the second one is taken as new writing under its own id
 * rather than dropped, since a note holds at most one block per origin.
 *
 * Returns { forkBlocks: [{ id, html }], hiddenOrigins: string[] }.
 */
export function reconcileStream({ baseline, docBlocks, noteId, today, hiddenOrigins = [] }) {
  const base = baseline || new Map()
  const seen = new Set()
  const forkBlocks = []

  for (const b of docBlocks || []) {
    const html = b.html || ''
    let origin = originOf(b) || b.id
    let entry = base.get(origin)
    if (seen.has(origin)) {
      origin = b.id
      entry = null
      if (seen.has(origin)) continue
    }
    seen.add(origin)

    if (entry) {
      const changed = html !== entry.html
      if (!changed && !entry.isFork) continue
      forkBlocks.push({
        id: origin,
        html: setBlockAttrs(changed ? html : entry.html, {
          'data-bid': origin,
          'data-origin': origin,
          'data-src': entry.src,
          'data-date': entry.date,
        }),
      })
      continue
    }
    if (isBlankHtml(html)) continue
    forkBlocks.push({
      id: origin,
      html: setBlockAttrs(html, {
        'data-bid': origin,
        'data-origin': origin,
        'data-src': noteId ? `note:${noteId}` : null,
        'data-date': today,
      }),
    })
  }

  const hidden = new Set((hiddenOrigins || []).filter(o => !seen.has(o)))
  for (const origin of base.keys()) if (!seen.has(origin)) hidden.add(origin)
  return { forkBlocks, hiddenOrigins: [...hidden] }
}
