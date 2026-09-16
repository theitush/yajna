/**
 * Porting pre-bijection notes: every note title must be a tag (#9), and the
 * notes written before that rule have free-text titles ("Daily standup",
 * "Q3 plans", or nothing). This is deliberately NOT a silent slugify — the
 * user sees each note, the tag it would get, and fixes it before anything is
 * written (#35). These are the pure parts; PortNotesBanner.jsx is the UI.
 */
import { canonicalTag, tagFromTitle } from '../../lib/hashtags.js'
import { resolveTagNote } from '../../lib/tagIndex.js'
import { blocksToHtml } from '../../lib/blocks.js'
import { htmlToPlainText } from '../../lib/search.js'

/** A stored note whose title is not already the one canonical spelling of a tag. */
export function needsTag(note) {
  const title = note?.title || ''
  return !title || canonicalTag(title) !== title
}

function firstLine(note) {
  const text = htmlToPlainText(blocksToHtml(note?.blocks))
  return text.length > 60 ? text.slice(0, 57).trimEnd() + '…' : text
}

/** What to show for the note: its title, else its first line, else "Untitled". */
export function noteLabel(note) {
  return (note?.title || '').trim() || firstLine(note) || 'Untitled'
}

/** The proposed tag: slug of the title, else of the first line, else empty. */
export function proposeTag(note) {
  return tagFromTitle(note?.title) || tagFromTitle(firstLine(note)) || ''
}

/**
 * Plan the port. `pending` are the notes that need a tag, `edits` is
 * { [noteId]: string } of what the user typed over the proposals.
 *
 * Returns { rows, ready }. Each row: { id, label, value, tag, problem } where
 * `problem` is null or one of:
 *   'not a tag'                 — canonicalTag rejects the value
 *   'used twice here'           — another row proposes the same tag
 *   '#<tag> already has a note' — an existing note answers to that tag
 * Nothing is applied while any row has a problem; collisions are resolved by
 * hand, never merged behind the user's back (#9).
 */
export function planPort(pending, notes, edits = {}) {
  const rows = (pending || []).map(note => {
    const value = edits[note.id] ?? proposeTag(note)
    return { id: note.id, label: noteLabel(note), value, tag: canonicalTag(value), problem: null }
  })
  const count = new Map()
  for (const r of rows) if (r.tag) count.set(r.tag, (count.get(r.tag) || 0) + 1)
  for (const r of rows) {
    if (!r.tag) { r.problem = 'not a tag'; continue }
    if (count.get(r.tag) > 1) { r.problem = 'used twice here'; continue }
    const owner = resolveTagNote(notes, r.tag)
    if (owner && owner.id !== r.id) r.problem = `#${r.tag} already has a note`
  }
  return { rows, ready: rows.length > 0 && rows.every(r => !r.problem) }
}
