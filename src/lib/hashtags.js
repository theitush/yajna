import { blocksToHtml } from './blocks'

const HASHTAG_RE = /#([\p{L}\p{N}_-]+)/gu

export function extractHashtags(text) {
  if (!text) return []
  const out = new Set()
  for (const m of String(text).matchAll(HASHTAG_RE)) out.add(m[1].toLowerCase())
  return [...out]
}

export function collectAllHashtags({ notes = [], tasks = [], journal = null } = {}) {
  const set = new Set()
  for (const n of notes) {
    for (const t of n.tags || []) set.add(String(t).toLowerCase())
    for (const t of extractHashtags(n.body ?? blocksToHtml(n.blocks))) set.add(t)
  }
  for (const t of tasks) {
    for (const tag of extractHashtags(`${t.title || ''} ${t.explanation || ''} ${t.feedback || ''} ${t.tags || ''}`)) set.add(tag)
  }
  if (journal?.blocks) {
    for (const tag of extractHashtags(blocksToHtml(journal.blocks))) set.add(tag)
  }
  return [...set].sort()
}

export { HASHTAG_RE }
