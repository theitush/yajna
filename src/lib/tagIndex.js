/**
 * The tag index: which paragraphs, anywhere, a #tag has captured.
 *
 * A tag's note is NOT a copy of those paragraphs. It is the note's own stored
 * body plus a stream DERIVED here, at read time, from every journal day and
 * every other note that mentions the tag (per the capture rule in
 * hashtags.js). Only a paragraph the user edits *inside* the note is stored
 * — a "fork" — as a note block whose html carries:
 *
 *   data-origin="<bid of the block a human originally typed>"
 *   data-src="journal:<date>" | "note:<id>"      where it was captured from
 *   data-date="<YYYY-MM-DD>"                       the day shown on its marker
 *
 * exactly the way `data-bid` already rides html (BlockIdExtension), so the
 * sync layer needs no schema work. Identity is the origin block: a note holds
 * at most one block per origin, which is what makes note-to-note capture
 * settle in one round however tangled the routes (#9).
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

function attr(re, html) {
  const m = re.exec(html || '')
  return m ? m[1] : null
}

/** The origin block id a stored block stands for: its data-origin, else itself. */
export function originOf(block) {
  return attr(ORIGIN_RE, block?.html) || block?.id || null
}

/** True when a stored note block is a fork (a captured paragraph the note holds its own copy of). */
export function isForkBlock(block) {
  return attr(ORIGIN_RE, block?.html) != null
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
 *             srcId, date }
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
    for (const b of blocks) if (b && !b.deleted && b.id != null) byId.set(b.id, b)
    for (const [tag, ids] of scopes.byTag) {
      if (skipTags?.has(tag)) continue
      for (const id of ids) {
        const b = byId.get(id)
        if (!b) continue
        bump(tag, toMs(b.updatedAt) || docMs)
        push({
          tag,
          origin: originOf(b),
          blockId: b.id,
          html: b.html || '',
          order: b.order ?? null,
          srcType,
          srcId,
          date: dateOf(b),
        })
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
 * The stream shown under a tag-note's own body: one entry per origin.
 *
 *   - captures for the tag and every alias of its note;
 *   - an origin the note HOLDS (a fork block whose data-origin — or bid — is
 *     that origin) shows the note's own copy, not the live source;
 *   - an origin in the note's `hiddenOrigins` is dropped;
 *   - otherwise the original block (blockId === origin) beats a fork copy
 *     sitting in some other note;
 *   - a fork whose source has since gone (paragraph deleted, tag removed) is
 *     still shown — a forked copy outlives its origin (#9).
 *
 * Sorted by day, then `order`, then id. Returns
 * [{ origin, html, date, srcType, srcId, order, isFork }].
 */
export function noteStream(index, notes, tag) {
  const t = canonicalTag(tag)
  if (!t) return []
  const note = resolveTagNote(notes, t)
  const tags = note ? noteTags(note) : new Set([t])
  const hidden = new Set(note?.hiddenOrigins || [])

  const held = new Map()
  for (const b of sortByOrder((note?.blocks || []).filter(b => b && !b.deleted))) {
    if (isForkBlock(b)) held.set(originOf(b), b)
  }

  const groups = new Map()
  for (const tg of tags) {
    for (const cap of index?.captures?.get(tg) || []) {
      if (note && cap.srcType === 'note' && cap.srcId === note.id) continue
      const list = groups.get(cap.origin) || []
      list.push(cap)
      groups.set(cap.origin, list)
    }
  }

  const out = []
  const forkEntry = (origin, b) => {
    const src = forkSource(b) || {}
    return {
      origin,
      html: b.html || '',
      date: attr(DATE_RE, b.html) || dayKey(b.updatedAt || undefined),
      srcType: src.srcType || 'note',
      srcId: src.srcId || note?.id || null,
      order: b.order ?? null,
      isFork: true,
    }
  }
  for (const [origin, caps] of groups) {
    if (hidden.has(origin)) continue
    const fork = held.get(origin)
    if (fork) {
      out.push(forkEntry(origin, fork))
      continue
    }
    const pick = caps.find(c => c.blockId === origin) || caps[0]
    out.push({
      origin,
      html: pick.html,
      date: pick.date,
      srcType: pick.srcType,
      srcId: pick.srcId,
      order: pick.order,
      isFork: false,
    })
  }
  for (const [origin, b] of held) {
    if (groups.has(origin) || hidden.has(origin)) continue
    out.push(forkEntry(origin, b))
  }

  return out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    const ao = a.order, bo = b.order
    if (ao != null && bo != null && ao !== bo) return ao < bo ? -1 : 1
    if (ao == null && bo != null) return 1
    if (ao != null && bo == null) return -1
    return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0
  })
}
