/**
 * Block-level sync primitives for rich-text content (journal entries, notes).
 *
 * Why: entry-level "last-write-wins" silently drops data when two devices
 * (or the same device, offline then online) edit the same entry. We split
 * content into top-level blocks (paragraphs, headings, lists, audio, ...)
 * each with a stable id and its own updatedAt. Merges then happen per block.
 *
 * Conflict policy: safe — never drop a block. If both sides edited the same
 * block id, the older side's version is appended right after as a separate
 * block (marked data-conflict="1") so nothing is silently lost.
 */
import { v4 as uuid } from 'uuid'

const CONFLICT_ATTR = 'data-conflict'
const BLOCK_ID_ATTR = 'data-bid'

/**
 * Parse an HTML string into an array of top-level blocks.
 *  [{ id, html }]
 * Blocks without a data-bid get a fresh uuid — this is how legacy data
 * (a single HTML blob) gets split the first time it's saved.
 */
export function htmlToBlocks(html) {
  if (!html) return []
  const container = document.createElement('div')
  container.innerHTML = html
  const out = []
  for (const child of Array.from(container.children)) {
    let id = child.getAttribute(BLOCK_ID_ATTR)
    if (!id) {
      id = uuid()
      child.setAttribute(BLOCK_ID_ATTR, id)
    }
    out.push({ id, html: child.outerHTML })
  }
  // If there were no element children (pure text), wrap as a single paragraph.
  if (out.length === 0 && container.textContent.trim()) {
    const p = document.createElement('p')
    p.textContent = container.textContent
    const id = uuid()
    p.setAttribute(BLOCK_ID_ATTR, id)
    out.push({ id, html: p.outerHTML })
  }
  return out
}

/**
 * Reassemble blocks into an HTML string.
 */
export function blocksToHtml(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return ''
  return blocks.map(b => b.html).join('')
}

/**
 * Compute the next blocks snapshot given previous blocks and current HTML.
 * Bumps updatedAt only for blocks whose html actually changed. New blocks
 * get a fresh updatedAt. Unchanged blocks keep their prior timestamps.
 *
 * Returns [{ id, html, updatedAt }]
 */
export function stampBlocks(prevBlocks, newHtml, nowIso) {
  const now = nowIso || new Date().toISOString()
  const prevById = new Map()
  for (const b of prevBlocks || []) prevById.set(b.id, b)
  const next = htmlToBlocks(newHtml)
  return next.map(b => {
    const prior = prevById.get(b.id)
    if (prior && prior.html === b.html) {
      return { id: b.id, html: b.html, updatedAt: prior.updatedAt || now }
    }
    return { id: b.id, html: b.html, updatedAt: now }
  })
}

/**
 * Merge two block arrays. For blocks present on both sides with matching
 * content, newer updatedAt wins (trivially). For blocks present only on
 * one side, they are kept. For blocks present on both sides with DIFFERENT
 * content, the newer wins AND the older is preserved immediately after as
 * a conflict-marked clone (new id, marked data-conflict). Nothing is ever
 * silently dropped.
 *
 * Order is taken from the side with the newer overall stamp; blocks only
 * on the other side are appended at the end in their own order.
 */
export function mergeBlocks(localBlocks, remoteBlocks, localStampIso, remoteStampIso) {
  const local = Array.isArray(localBlocks) ? localBlocks : []
  const remote = Array.isArray(remoteBlocks) ? remoteBlocks : []
  if (local.length === 0) return remote.slice()
  if (remote.length === 0) return local.slice()

  const localTime = toMs(localStampIso)
  const remoteTime = toMs(remoteStampIso)
  const primary = remoteTime > localTime ? remote : local
  const secondary = primary === remote ? local : remote

  const primaryMap = new Map(primary.map(b => [b.id, b]))
  const secondaryMap = new Map(secondary.map(b => [b.id, b]))

  const out = []
  const consumed = new Set()

  for (const pb of primary) {
    const sb = secondaryMap.get(pb.id)
    if (!sb) {
      out.push(pb)
      continue
    }
    consumed.add(pb.id)
    if (pb.html === sb.html) {
      // Same content — keep newer updatedAt for housekeeping.
      const newer = toMs(pb.updatedAt) >= toMs(sb.updatedAt) ? pb : sb
      out.push(newer)
      continue
    }
    const pT = toMs(pb.updatedAt)
    const sT = toMs(sb.updatedAt)
    const winner = pT >= sT ? pb : sb
    const loser = winner === pb ? sb : pb
    out.push(winner)
    // Preserve the loser immediately after, marked as a conflict.
    out.push(cloneAsConflict(loser))
  }
  for (const sb of secondary) {
    if (consumed.has(sb.id)) continue
    out.push(sb)
  }
  return out
}

function cloneAsConflict(block) {
  // Give the conflict clone a fresh id so future edits on either device
  // don't reintroduce the collision.
  const container = document.createElement('div')
  container.innerHTML = block.html
  const el = container.firstElementChild
  if (el) {
    el.setAttribute(CONFLICT_ATTR, '1')
    const newId = uuid()
    el.setAttribute(BLOCK_ID_ATTR, newId)
    return { id: newId, html: el.outerHTML, updatedAt: block.updatedAt }
  }
  return { id: uuid(), html: block.html, updatedAt: block.updatedAt }
}

function toMs(iso) {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return isFinite(t) ? t : 0
}
