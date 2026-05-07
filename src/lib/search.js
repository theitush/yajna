import { blocksToHtml } from './blocks'

// Strip HTML tags and decode a few common entities. Used to flatten note /
// journal block content into a single searchable string. Not a full HTML
// parser — fine for our editor output.
export function htmlToPlainText(html) {
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// Walk a blocks array and return per-block searchable text plus its id and
// any audio ids embedded in that block. Audio-only blocks return text=''
// (the caller folds in the audio transcripts via `audioMap`). Used to build
// per-block search docs so a search hit can navigate to the exact paragraph.
export function blocksWithText(blocks) {
  const out = []
  if (!Array.isArray(blocks)) return out
  for (const b of blocks) {
    if (b?.deleted) continue
    const html = b?.html || ''
    const audioIds = []
    const re = /data-audio-id="([^"]+)"/g
    let m
    while ((m = re.exec(html))) audioIds.push(m[1])
    const text = htmlToPlainText(html)
    out.push({ blockId: b?.id || null, text, audioIds })
  }
  return out
}

// Walk a blocks array (note or journal entry) and return all embedded audio ids.
export function audioIdsFromBlocks(blocks) {
  const ids = []
  if (!Array.isArray(blocks)) return ids
  for (const b of blocks) {
    const html = b?.html || ''
    const re = /data-audio-id="([^"]+)"/g
    let m
    while ((m = re.exec(html))) ids.push(m[1])
  }
  return ids
}

export function blocksToPlainText(blocks) {
  return htmlToPlainText(blocksToHtml(blocks))
}

// Build the searchable text for a record by combining its body text with
// any transcripts from embedded audio. The audioMap is { [id]: transcript }.
export function buildSearchableText(parts) {
  return parts.filter(Boolean).join(' \n ').trim()
}

// Given a string and a list of Fuse match indices for that field, render
// the string with <mark> tags around matched ranges. Returns an array of
// React-renderable nodes (strings + JSX). If no indices, returns [str].
//
// indices is an array of [start, end] inclusive ranges.
export function highlightRanges(str, indices) {
  if (!str) return ['']
  if (!indices || indices.length === 0) return [str]
  // Sort and merge overlapping ranges defensively.
  const sorted = [...indices].sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  const out = []
  let cursor = 0
  let key = 0
  for (const [s, e] of merged) {
    if (s > cursor) out.push(str.slice(cursor, s))
    out.push({ __mark: true, key: key++, text: str.slice(s, e + 1) })
    cursor = e + 1
  }
  if (cursor < str.length) out.push(str.slice(cursor))
  // Caller renders {parts.map(p => typeof p === 'string' ? p : <mark key>...)}
  return out
}

// Build a snippet around the first match index. Returns { text, indices }
// where indices are remapped to the snippet's coordinate space.
export function snippetAround(str, indices, radius = 60) {
  if (!str) return { text: '', indices: [] }
  if (!indices || indices.length === 0) {
    return { text: str.length > radius * 2 ? str.slice(0, radius * 2) + '…' : str, indices: [] }
  }
  const first = [...indices].sort((a, b) => a[0] - b[0])[0]
  const start = Math.max(0, first[0] - radius)
  const end = Math.min(str.length, first[1] + 1 + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < str.length ? '…' : ''
  const text = prefix + str.slice(start, end) + suffix
  const offset = prefix.length - start
  const remapped = indices
    .filter(([s, e]) => e >= start && s < end)
    .map(([s, e]) => [Math.max(0, s + offset), Math.min(text.length - 1, e + offset)])
  return { text, indices: remapped }
}
