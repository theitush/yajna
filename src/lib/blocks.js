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
    const existing = child.getAttribute(BLOCK_ID_ATTR)
    const id = existing || stableIdFromContent(contentKey(child))
    // updatedAt: 0 — parsed-from-HTML blocks lose to any stamped edit, and
    // collide deterministically with their peers on other devices.
    out.push({ id, html: child.outerHTML, updatedAt: new Date(0).toISOString() })
  }
  if (out.length === 0 && container.textContent.trim()) {
    const text = container.textContent
    out.push({
      id: stableIdFromContent(text),
      html: `<p>${escapeHtml(text)}</p>`,
      updatedAt: new Date(0).toISOString(),
    })
  }
  return out
}

// Content fingerprint used for deterministic ids. Strips data-bid so two
// devices that stored the same paragraph with different bids converge to
// the same id on re-parse. Uses textContent + tagName so attribute-order
// differences don't fork the id either.
function contentKey(el) {
  return `${el.tagName}|${el.textContent}`
}

export function blocksToHtml(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return ''
  return blocks.filter(b => !b.deleted).map(b => b.html).join('')
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
  const currentIds = new Set(currentBlocks.map(b => b.id))
  const out = currentBlocks.map(b => {
    const prior = prevById.get(b.id)
    if (prior && !prior.deleted && prior.html === b.html) {
      return { id: b.id, html: b.html, updatedAt: prior.updatedAt || now }
    }
    return { id: b.id, html: b.html, updatedAt: now }
  })
  // Tombstone any prior block whose id is no longer in the editor doc.
  // Without this, a local delete gets re-introduced on the next sync
  // because remote still holds the block and merge treats it as
  // "remote-only, keep."
  for (const prior of prevBlocks || []) {
    if (currentIds.has(prior.id)) continue
    if (prior.deleted) {
      out.push(prior)
    } else {
      out.push({ id: prior.id, deleted: true, updatedAt: now })
    }
  }
  return out
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
  // Dedupe each side by id first. Prior bugs produced stored arrays with
  // duplicate ids and with near-duplicates (same content, different ids);
  // collapsing here makes every merge an idempotent cleanup pass so existing
  // corruption in Drive/IDB gets fixed on the next sync.
  const local = dedupeById(Array.isArray(localBlocks) ? localBlocks : [])
  const remote = dedupeById(Array.isArray(remoteBlocks) ? remoteBlocks : [])
  if (local.length === 0) return remote.slice()
  if (remote.length === 0) return local.slice()
  if (blocksEqual(local, remote)) return local

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
    // Tombstone semantics: a deletion stamped at time T beats alive content
    // stamped at the same time T (deletes shouldn't lose to stale edits).
    // Alive only wins if strictly newer — someone actively re-added content
    // after the delete.
    const lt = toMs(lb.updatedAt)
    const rt = toMs(rb.updatedAt)
    let winner
    if (lb.deleted && !rb.deleted) winner = rt > lt ? rb : lb
    else if (rb.deleted && !lb.deleted) winner = lt > rt ? lb : rb
    else winner = rt > lt ? rb : lb
    out.push(winner)
    seen.add(lb.id)
  }
  for (const rb of remote) {
    if (seen.has(rb.id)) continue
    out.push(rb)
  }
  return out
}

// Collapse duplicate ids within a single side. Newest updatedAt wins; ties
// keep the first occurrence so order stays stable.
function dedupeById(blocks) {
  const byId = new Map()
  const order = []
  for (const b of blocks) {
    if (!b || b.id == null) continue
    const prev = byId.get(b.id)
    if (!prev) {
      byId.set(b.id, b)
      order.push(b.id)
    } else if (toMs(b.updatedAt) > toMs(prev.updatedAt)) {
      byId.set(b.id, b)
    }
  }
  return order.map(id => byId.get(id))
}

/**
 * Drop block tombstones older than cutoff. Mirrors note/task purge in sync.js:
 * once every device has had time to see the delete, the tombstone can go.
 */
export function purgeOldBlockTombstones(blocks, cutoffIso) {
  if (!Array.isArray(blocks)) return blocks
  const cutoff = toMs(cutoffIso)
  return blocks.filter(b => !(b.deleted && toMs(b.updatedAt) < cutoff))
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
