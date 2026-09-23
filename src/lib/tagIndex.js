/**
 * The tag index: which paragraphs, anywhere, a #tag has captured.
 *
 * A tag's note is ONE document: the blocks the note stores, in the order the
 * note stores them, followed by every paragraph the tag has captured that the
 * note has not placed yet (DERIVED here, at read time, from every journal day
 * and every other note that mentions the tag, per the capture rule in
 * hashtags.js). A captured paragraph is a note block whose html carries:
 *
 *   data-origin="<bid of the block a human originally typed>"
 *   data-src="journal:<date>" | "note:<id>"      where it was captured from
 *   data-date="<YYYY-MM-DD>"                       the day shown on its marker
 *   data-mirror="1"                                still following its source
 *
 * exactly the way `data-bid` already rides html (BlockIdExtension), so the
 * sync layer needs no schema work. A MIRROR is a placement, not a copy the
 * note owns: it is stored so the paragraph has a fixed place in the note (the
 * end, the moment it first arrived — #48), but what it shows is always the
 * live source, so a journal edit flows through. Editing it in the note drops
 * the mirror flag: the block is now a FORK, the note's own copy, and the
 * source is never touched. Identity is the origin block: a note holds at most
 * one block per origin, which is what makes note-to-note capture settle in
 * one round however tangled the routes (#9).
 *
 * READ-ONLY BY CONSTRUCTION. This module imports no writer: nothing here can
 * change a journal day, and nothing that assembles a note's stream should.
 * Notes never write the journal; the journal is the historical record.
 */
import { canonicalTag, captureScopesFromBlocks } from './hashtags.js'
import { sortByOrder } from './blocks.js'
import { dayKey } from './dates.js'

const ATTR_RE = (name) => new RegExp(`\\s${name}="([^"]*)"`)
const ORIGIN_RE = ATTR_RE('data-origin')
const SRC_RE = ATTR_RE('data-src')
const DATE_RE = ATTR_RE('data-date')
const MIRROR_RE = ATTR_RE('data-mirror')

function attr(re, html) {
  const m = re.exec(html || '')
  return m ? m[1] : null
}

/** The origin block id a stored block stands for: its data-origin, else itself. */
export function originOf(block) {
  return attr(ORIGIN_RE, block?.html) || block?.id || null
}

/** True when a stored note block is a captured paragraph (a mirror or a fork) rather than the note's own writing. */
export function isCapturedBlock(block) {
  return attr(ORIGIN_RE, block?.html) != null
}

/** True when a stored captured block still follows its source (data-mirror). */
export function isMirrorBlock(block) {
  return isCapturedBlock(block) && attr(MIRROR_RE, block?.html) != null
}

/** True when a stored note block is a fork (a captured paragraph the note holds its own copy of). */
export function isForkBlock(block) {
  return isCapturedBlock(block) && attr(MIRROR_RE, block?.html) == null
}

/** `{ srcType, srcId }` from a fork's data-src, or null. */
export function forkSource(block) {
  const src = attr(SRC_RE, block?.html)
  if (!src) return null
  const i = src.indexOf(':')
  if (i < 0) return null
  return { srcType: src.slice(0, i), srcId: src.slice(i + 1) }
}

function toMs(iso) {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return isFinite(t) ? t : 0
}

/** Tags a note answers to: its canonical title plus every former name. */
export function noteTags(note) {
  const out = new Set()
  const t = canonicalTag(note?.title)
  if (t) out.add(t)
  for (const a of note?.aliases || []) {
    const c = canonicalTag(a)
    if (c) out.add(c)
  }
  return out
}

/**
 * Build the index over every journal day and every live note.
 *
 * Returns {
 *   captures: Map<tag, Capture[]>,
 *   lastUsed: Map<tag, ms>,
 * }
 * Capture = { tag, origin, blockId, html, order, srcType: 'journal'|'note',
 *             srcId, date, header? }
 *
 * `header: true` marks the tag-only line that opened a scope with content
 * under it: it is shown in the note above what it captured, as in the
 * journal (#48), but it is not what the tag "took".
 *
 * A note never captures its own tag (or an alias of it) from itself — a note
 * mentioning `#groceries` inside the `#groceries` note is just text.
 * `lastUsed` is the newest block stamp that used the tag (falling back to the
 * doc's own updatedAt), plus a note's updatedAt for its own tag, so a tag-note
 * you edit ranks as recently used even if the journal never mentions it.
 */
export function buildTagIndex({ journals = [], notes = [] } = {}) {
  const captures = new Map()
  const lastUsed = new Map()
  const bump = (tag, ms) => {
    if (!tag || !ms) return
    if ((lastUsed.get(tag) || 0) < ms) lastUsed.set(tag, ms)
  }
  const push = (cap) => {
    const list = captures.get(cap.tag) || []
    list.push(cap)
    captures.set(cap.tag, list)
  }

  const indexBlocks = (blocks, docMs, srcType, srcId, dateOf, skipTags) => {
    if (!Array.isArray(blocks) || blocks.length === 0) return
    const scopes = captureScopesFromBlocks(blocks)
    if (scopes.byTag.size === 0) return
    const byId = new Map()
    // A mirror shows its source's text, and the source is indexed on its own;
    // indexing the mirror too would only make the same origin arrive twice.
    for (const b of blocks) if (b && !b.deleted && b.id != null && !isMirrorBlock(b)) byId.set(b.id, b)
    const cap = (tag, b, header) => ({
      tag,
      origin: originOf(b),
      blockId: b.id,
      html: b.html || '',
      order: b.order ?? null,
      srcType,
      srcId,
      date: dateOf(b),
      ...(header ? { header: true } : {}),
    })
    for (const [tag, ids] of scopes.byTag) {
      if (skipTags?.has(tag)) continue
      for (const id of ids) {
        const b = byId.get(id)
        if (!b) continue
        bump(tag, toMs(b.updatedAt) || docMs)
        push(cap(tag, b, false))
      }
      for (const id of scopes.headersByTag.get(tag) || []) {
        const b = byId.get(id)
        if (b) push(cap(tag, b, true))
      }
    }
  }

  for (const doc of journals || []) {
    if (!doc?.date) continue
    indexBlocks(doc.blocks, toMs(doc.updatedAt), 'journal', doc.date, () => doc.date, null)
  }
  for (const note of notes || []) {
    if (!note || note.deleted) continue
    const self = noteTags(note)
    const noteMs = toMs(note.updatedAt)
    for (const t of self) bump(t, noteMs)
    indexBlocks(
      note.blocks,
      noteMs,
      'note',
      note.id,
      // A fork inside a note keeps the day it was captured on; a paragraph
      // typed in the note is dated by its own stamp.
      (b) => attr(DATE_RE, b.html) || dayKey(b.updatedAt || note.updatedAt || undefined),
      self,
    )
  }
  return { captures, lastUsed }
}

/** The stored note (if any) that a tag resolves to — by title, or by a former name. */
export function resolveTagNote(notes, tag) {
  const t = canonicalTag(tag)
  if (!t) return null
  return (notes || []).find(n => n && !n.deleted && noteTags(n).has(t)) || null
}

/**
 * The document a tag-note shows, in order. Returns
 * [{ kind: 'own'|'mirror'|'fork', id, origin, html, date, srcType, srcId }].
 *
 *   1. The note's stored blocks, in the note's own order — this is what keeps
 *      a line where the writer left it (#48):
 *        - own writing (no data-origin) as stored;
 *        - a fork (data-origin, no data-mirror) as stored: the note's copy;
 *        - a mirror (data-origin + data-mirror) showing the LIVE source: the
 *          original block if the tag still captures it, else a fork of it in
 *          some other note. A mirror whose source no longer captures for this
 *          tag is dropped — an unforked copy vanishes with its source (#9).
 *   2. Then every capture for the tag and its aliases whose origin the note
 *      holds nowhere and has not hidden. One from a source and day the note
 *      already holds blocks of — a new line under a header that is already
 *      here, the header line itself — JOINS that run, in the source's order
 *      (#48: "change in the hashtag block, not another one"). Anything else
 *      is a new run and arrives at the END of the note, sorted by day, then
 *      source, then the source's `order`, then id. Either way they are shown
 *      as mirrors and become stored ones on the note's next save, which is
 *      what fixes their place.
 *
 * A note never captures its own tag from itself, and an origin the note holds
 * appears once whatever else mentions it. Pure; reads only.
 */
export function noteDocument(index, notes, tag) {
  const t = canonicalTag(tag)
  if (!t) return []
  const note = resolveTagNote(notes, t)
  const tags = note ? noteTags(note) : new Set([t])
  const hidden = new Set(note?.hiddenOrigins || [])

  const groups = new Map()
  for (const tg of tags) {
    for (const cap of index?.captures?.get(tg) || []) {
      if (note && cap.srcType === 'note' && cap.srcId === note.id) continue
      const list = groups.get(cap.origin) || []
      list.push(cap)
      groups.set(cap.origin, list)
    }
  }
  const live = (origin) => {
    const caps = groups.get(origin)
    if (!caps) return null
    return caps.find(c => c.blockId === origin) || caps[0]
  }

  // `run` (source|day) and `order` (the SOURCE's key, so siblings from one
  // day compare) ride along for placement and are stripped before return.
  const runOf = (e) => `${e.srcType}:${e.srcId}|${e.date}`
  const out = []
  const held = new Set()
  for (const b of sortByOrder((note?.blocks || []).filter(b => b && !b.deleted))) {
    if (!isCapturedBlock(b)) {
      out.push({ kind: 'own', id: b.id, origin: null, html: b.html || '', date: null, srcType: null, srcId: null })
      continue
    }
    const origin = originOf(b)
    if (held.has(origin)) continue
    held.add(origin)
    if (hidden.has(origin)) continue
    const src = forkSource(b) || {}
    const date = attr(DATE_RE, b.html) || dayKey(b.updatedAt || undefined)
    const pick = live(origin)
    if (isMirrorBlock(b)) {
      if (!pick) continue
      out.push({ kind: 'mirror', id: origin, origin, html: pick.html, date, srcType: pick.srcType, srcId: pick.srcId, order: pick.order ?? null })
      continue
    }
    out.push({
      kind: 'fork', id: origin, origin, html: b.html || '', date,
      srcType: src.srcType || 'note', srcId: src.srcId || note?.id || null,
      order: pick?.order ?? null,
    })
  }

  const fresh = []
  for (const [origin, caps] of groups) {
    if (held.has(origin) || hidden.has(origin)) continue
    const pick = caps.find(c => c.blockId === origin) || caps[0]
    fresh.push({ kind: 'mirror', id: origin, origin, html: pick.html, date: pick.date, srcType: pick.srcType, srcId: pick.srcId, order: pick.order ?? null })
  }
  const byOrder = (a, b) => {
    const ao = a.order, bo = b.order
    if (ao != null && bo != null && ao !== bo) return ao < bo ? -1 : 1
    if (ao == null && bo != null) return 1
    if (ao != null && bo == null) return -1
    return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0
  }
  fresh.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    const as = `${a.srcType}:${a.srcId}`, bs = `${b.srcType}:${b.srcId}`
    if (as !== bs) return as < bs ? -1 : 1
    return byOrder(a, b)
  })
  const tail = []
  for (const e of fresh) {
    const run = runOf(e)
    // The note already holds this run: slot in after the last sibling that
    // comes before it in the source, else before the first sibling.
    let after = -1
    let first = -1
    for (let i = 0; i < out.length; i++) {
      const o = out[i]
      if (o.kind === 'own' || runOf(o) !== run) continue
      if (first < 0) first = i
      if (byOrder(o, e) < 0) after = i
    }
    if (first < 0) {
      tail.push(e)
      continue
    }
    out.splice(after >= 0 ? after + 1 : first, 0, e)
  }
  out.push(...tail)
  for (const e of out) delete e.order
  return out
}
