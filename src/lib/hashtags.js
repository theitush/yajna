import { sortByOrder } from './blocks.js'
import { blocksWithText } from './search.js'

const HASHTAG_RE = /#([\p{L}\p{N}_-]+)/gu
// A whole string that is one tag body (no `#`). Same class as HASHTAG_RE.
const TAG_BODY_RE = /^[\p{L}\p{N}_-]+$/u

export function extractHashtags(text) {
  if (!text) return []
  const out = new Set()
  for (const m of String(text).matchAll(HASHTAG_RE)) out.add(m[1].toLowerCase())
  return [...out]
}

/**
 * The one canonical spelling of a tag: no leading `#`, lowercase. Returns
 * null when the string is not a tag at all (spaces, empty, punctuation).
 * `#Groceries`, `groceries` and `GROCERIES` are the same note.
 */
export function canonicalTag(s) {
  if (s == null) return null
  const body = String(s).trim().replace(/^#+/, '').toLowerCase()
  return TAG_BODY_RE.test(body) ? body : null
}

/**
 * Best-effort tag for a free-text title ("Daily standup" → "daily-standup").
 * Used only to PROPOSE a tag when porting pre-bijection notes; the user
 * confirms. Null when nothing tag-like survives.
 */
export function tagFromTitle(title) {
  if (title == null) return null
  const slug = String(title)
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? slug : null
}

// Text with every hashtag removed; used to tell a header line ("#a #b") from a
// paragraph that merely mentions tags.
function withoutTags(text) {
  return String(text || '').replace(HASHTAG_RE, '')
}

/**
 * The capture rule. Given a document's blocks in display order as
 * `[{ id, text, empty? }]` (plain text — html already stripped, audio
 * transcripts folded in; `empty` overrides the text test for a block that has
 * no text but is content, e.g. an untranscribed clip), decide which tags
 * capture which blocks:
 *
 *   - A tag inline in a paragraph with other text captures that paragraph.
 *   - A block whose text is ONLY tags is a header: it captures the following
 *     consecutive blocks up to (not including) an empty block or the next
 *     header. The header line itself is not content.
 *   - A block inside a header's scope that carries its own inline tags is
 *     captured by both.
 *   - A header whose scope captured at least one block is reported in
 *     `headersByTag`, so a tag's note can show the line the way the journal
 *     does, above what it took (#48). A header with nothing under it is just
 *     a line that says a tag.
 *
 * No setting: the rule adapts to how the tag was written, and the journal
 * editor frames the captured blocks so the writer sees exactly what a tag
 * is taking (#9, Ita's review note).
 *
 * Returns { byBlock: Map<id, tag[]>, byTag: Map<tag, id[]>, headers: Set<id>,
 *           headersByTag: Map<tag, id[]> }.
 * Pure; never touches a document.
 */
export function captureScopes(items) {
  const byBlock = new Map()
  const byTag = new Map()
  const headers = new Set()
  const add = (id, tag) => {
    const tags = byBlock.get(id) || []
    if (!tags.includes(tag)) tags.push(tag)
    byBlock.set(id, tags)
    const ids = byTag.get(tag) || []
    if (!ids.includes(id)) ids.push(id)
    byTag.set(tag, ids)
  }

  const headersByTag = new Map()
  let openHeader = null // { id, tags } of the header whose scope we are inside
  for (const item of items || []) {
    if (!item || item.id == null) continue
    const text = String(item.text || '')
    const tags = extractHashtags(text)
    const isEmpty = item.empty ?? text.trim() === ''
    const isHeader = tags.length > 0 && withoutTags(text).trim() === ''

    if (isHeader) {
      headers.add(item.id)
      openHeader = { id: item.id, tags, counted: false }
      continue
    }
    if (isEmpty) {
      openHeader = null
      continue
    }
    for (const tag of tags) add(item.id, tag)
    if (openHeader) {
      for (const tag of openHeader.tags) add(item.id, tag)
      if (!openHeader.counted) {
        openHeader.counted = true
        for (const tag of openHeader.tags) {
          const ids = headersByTag.get(tag) || []
          ids.push(openHeader.id)
          headersByTag.set(tag, ids)
        }
      }
    }
  }
  return { byBlock, byTag, headers, headersByTag }
}

/**
 * captureScopes over stored blocks (journal day or note). Tombstoned blocks
 * are skipped; ordering is the fractional `order` key; audio transcripts count
 * as the block's text (blocksWithText already folds `data-transcript` in), so
 * a clip is never an "empty" scope terminator and a spoken #tag captures.
 */
export function captureScopesFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return captureScopes([])
  const ordered = sortByOrder(blocks.filter(b => b && !b.deleted))
  const items = blocksWithText(ordered).map((b, i) => ({
    id: b.blockId ?? ordered[i].id,
    text: b.text,
    empty: b.audioIds.length > 0 ? false : undefined,
  }))
  return captureScopes(items)
}

export { HASHTAG_RE }
