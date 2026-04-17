/**
 * Block-level sync primitives for rich-text content (journal entries, notes).
 *
 * Content is split into top-level blocks (paragraphs, headings, lists,
 * audio, ...) each carrying a stable uuid in its `data-bid` attribute.
 * Merges are per-block so concurrent edits on different paragraphs both
 * survive. Same-block conflicts: last-write-wins per block (simple,
 * predictable). Block ids are assigned by BlockIdExtension while editing
 * and round-trip through HTML via its global attribute spec.
 */
import { v4 as uuid } from 'uuid'

const BLOCK_ID_ATTR = 'data-bid'

/**
 * Extract blocks from a TipTap/ProseMirror doc. This is the authoritative
 * path while editing: ids live on node attrs (set by BlockIdExtension), so
 * we never have to reparse HTML to recover them.
 *
 * Returns [{ id, html }] — one entry per top-level node.
 */
export function docToBlocks(doc, serializer) {
  if (!doc || !serializer) return []
  const out = []
  doc.forEach((node) => {
    const id = node.attrs?.bid || uuid()
    const fragment = serializer.serializeNode(node)
    const container = document.createElement('div')
    container.appendChild(fragment)
    out.push({ id, html: container.innerHTML })
  })
  return out
}

/**
 * Parse an HTML string into blocks. Used when we only have stored HTML
 * (e.g. during sync merges where there's no live editor). If a block has
 * no data-bid we derive a content-stable id so repeated re-parses of the
 * same HTML don't generate different ids (which would cause duplication).
 */
export function htmlToBlocks(html) {
  if (!html) return []
  const container = document.createElement('div')
  container.innerHTML = html
  const out = []
  for (const child of Array.from(container.children)) {
    const id = child.getAttribute(BLOCK_ID_ATTR) || stableIdFromContent(child.outerHTML)
    out.push({ id, html: child.outerHTML })
  }
  if (out.length === 0 && container.textContent.trim()) {
    const text = container.textContent
    out.push({ id: stableIdFromContent(text), html: `<p>${escapeHtml(text)}</p>` })
  }
  return out
}

export function blocksToHtml(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return ''
  return blocks.map(b => b.html).join('')
}

/**
 * Compute next blocks snapshot given prior blocks and current blocks (from
 * docToBlocks). Bumps updatedAt only on blocks whose content changed; new
 * blocks get a fresh stamp; unchanged blocks keep their prior stamp.
 */
export function stampBlocksFromDoc(prevBlocks, currentBlocks, nowIso) {
  const now = nowIso || new Date().toISOString()
  const prevById = new Map()
  for (const b of prevBlocks || []) prevById.set(b.id, b)
  return currentBlocks.map(b => {
    const prior = prevById.get(b.id)
    if (prior && prior.html === b.html) {
      return { id: b.id, html: b.html, updatedAt: prior.updatedAt || now }
    }
    return { id: b.id, html: b.html, updatedAt: now }
  })
}

/**
 * Back-compat wrapper for code paths that only have an HTML string.
 * Use stampBlocksFromDoc when a live editor is available — it's more
 * reliable because it reads ids from node attrs directly.
 */
export function stampBlocks(prevBlocks, newHtml, nowIso) {
  return stampBlocksFromDoc(prevBlocks, htmlToBlocks(newHtml), nowIso)
}

/**
 * Merge two block arrays by id. Per-block last-write-wins; blocks only on
 * one side are preserved. If both sides are identical (same ids, same
 * html, same order), local is returned unchanged (prevents merge churn).
 */
export function mergeBlocks(localBlocks, remoteBlocks) {
  const local = Array.isArray(localBlocks) ? localBlocks : []
  const remote = Array.isArray(remoteBlocks) ? remoteBlocks : []
  if (local.length === 0) return remote.slice()
  if (remote.length === 0) return local.slice()
  if (blocksEqual(local, remote)) return local

  const localMap = new Map(local.map(b => [b.id, b]))
  const remoteMap = new Map(remote.map(b => [b.id, b]))

  // Order: prefer local ordering; append any remote-only blocks at the end.
  // If you edit paragraph 2 locally and device B inserts a new paragraph 3,
  // merge keeps your local P1..P2 order and tacks on P3 after.
  const out = []
  const seen = new Set()
  for (const lb of local) {
    const rb = remoteMap.get(lb.id)
    if (!rb) {
      out.push(lb)
      seen.add(lb.id)
      continue
    }
    const winner = toMs(rb.updatedAt) > toMs(lb.updatedAt) ? rb : lb
    out.push(winner)
    seen.add(lb.id)
  }
  for (const rb of remote) {
    if (seen.has(rb.id)) continue
    out.push(rb)
  }
  return out
}

function blocksEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
    if (a[i].html !== b[i].html) return false
  }
  return true
}

function toMs(iso) {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return isFinite(t) ? t : 0
}

// Deterministic id derived from content. Collision is fine: two paragraphs
// with identical HTML should merge to one across devices.
function stableIdFromContent(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return 'c' + (h >>> 0).toString(36)
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
