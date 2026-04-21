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

// Fractional-index alphabet. Any two keys can have a new key generated
// strictly between them, so concurrent inserts on different devices
// converge to the same order after merge.
const FI_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const FI_BASE = FI_ALPHABET.length
const FI_MIN = FI_ALPHABET[0]
const FI_MID = FI_ALPHABET[Math.floor(FI_BASE / 2)]

function fiCharAt(s, i) {
  return i < s.length ? s[i] : FI_MIN
}

function fiIndexOf(ch) {
  const i = FI_ALPHABET.indexOf(ch)
  if (i < 0) throw new Error('fi: bad char ' + ch)
  return i
}

/**
 * Generate a key strictly between `a` and `b` (either may be null for
 * unbounded). Keys are lexicographically comparable strings. Never returns
 * a key equal to either bound.
 */
export function fiBetween(a, b) {
  if (a != null && b != null && a >= b) {
    throw new Error('fi: a must be < b, got ' + a + ',' + b)
  }
  let prefix = ''
  let i = 0
  // Walk the shared prefix. Once ca < cb, the answer sits inside the
  // segment above ca; if the gap is >1 in the alphabet we place a middle
  // char there. Otherwise we adopt ca and extend past `a` far enough to
  // land strictly above `a` and strictly below `b`.
  while (true) {
    const ca = a == null ? FI_MIN : fiCharAt(a, i)
    const cb = b == null ? null : fiCharAt(b, i)
    if (ca === cb) {
      prefix += ca
      i++
      continue
    }
    const ia = fiIndexOf(ca)
    const ib = cb == null ? FI_BASE : fiIndexOf(cb)
    if (ib - ia > 1) {
      return prefix + FI_ALPHABET[Math.floor((ia + ib) / 2)]
    }
    // ib - ia === 1: adopt ca so the result still starts with
    // prefix+ca (hence < b). Then append the remainder of `a` plus a
    // middle char — strictly greater than `a` because MID > empty.
    prefix += ca
    i++
    const tail = a == null ? '' : a.slice(i)
    return prefix + tail + FI_MID
  }
}

// Build evenly-spaced keys for a sequence of blocks. Used to seed `order`
// for legacy blocks that don't have keys yet.
function fiSequence(n) {
  const out = []
  let prev = null
  for (let i = 0; i < n; i++) {
    const key = fiBetween(prev, null)
    out.push(key)
    prev = key
  }
  return out
}

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
  const keys = fiSequence(out.length)
  for (let i = 0; i < out.length; i++) out[i].order = keys[i]
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
  return sortByOrder(blocks.filter(b => !b.deleted)).map(b => b.html).join('')
}

// Sort by fractional-index `order`, tie-breaking by id so devices with
// duplicate/missing keys still converge. Blocks missing `order` sort to
// the end (legacy data before the fractional-index migration).
function sortByOrder(blocks) {
  return blocks.slice().sort((a, b) => {
    const ao = a.order, bo = b.order
    if (ao == null && bo == null) return 0
    if (ao == null) return 1
    if (bo == null) return -1
    if (ao < bo) return -1
    if (ao > bo) return 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
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

  // Assign fractional-index `order` keys in editor order. Pass 1 marks
  // which prior keys are "anchor" keys — ones we keep, because they're
  // present and form a strictly-increasing subsequence in editor order.
  // Pass 2 fills the gaps with fresh keys generated strictly between the
  // surrounding anchors, so the sequence is monotonic across devices.
  const priorKey = currentBlocks.map(b => {
    const prior = prevById.get(b.id)
    return prior && !prior.deleted && prior.order ? prior.order : null
  })
  const isAnchor = new Array(currentBlocks.length).fill(false)
  let lastAnchor = null
  for (let i = 0; i < currentBlocks.length; i++) {
    if (priorKey[i] != null && (lastAnchor == null || priorKey[i] > lastAnchor)) {
      isAnchor[i] = true
      lastAnchor = priorKey[i]
    }
  }
  const finalOrder = new Array(currentBlocks.length)
  for (let i = 0; i < currentBlocks.length; i++) {
    if (isAnchor[i]) {
      finalOrder[i] = priorKey[i]
      continue
    }
    const lo = i > 0 ? finalOrder[i - 1] : null
    let hi = null
    for (let j = i + 1; j < currentBlocks.length; j++) {
      if (isAnchor[j]) { hi = priorKey[j]; break }
    }
    finalOrder[i] = fiBetween(lo, hi)
  }

  const out = currentBlocks.map((b, i) => {
    const prior = prevById.get(b.id)
    const order = finalOrder[i]
    const orderChanged = !prior || prior.order !== order
    if (prior && !prior.deleted && prior.html === b.html && !orderChanged) {
      return { id: b.id, html: b.html, order, updatedAt: prior.updatedAt || now }
    }
    return { id: b.id, html: b.html, order, updatedAt: now }
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
      out.push({ id: prior.id, deleted: true, order: prior.order, updatedAt: now })
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
  if (local.length === 0) return sortByOrder(remote)
  if (remote.length === 0) return sortByOrder(local)
  if (blocksEqual(local, remote)) return sortByOrder(local)

  const remoteMap = new Map(remote.map(b => [b.id, b]))

  // Per-block LWW. Ordering is derived from the fractional-index `order`
  // key afterwards, so the final sequence is identical on every device
  // regardless of which side arrived first.
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
    // Prefer whichever side has an `order` key; if both do, the LWW winner's
    // key is authoritative. This keeps legacy blocks that gained a key on
    // one device from losing it on merge.
    if (winner.order == null) {
      const alt = winner === lb ? rb : lb
      if (alt.order != null) winner = { ...winner, order: alt.order }
    }
    out.push(winner)
    seen.add(lb.id)
  }
  for (const rb of remote) {
    if (seen.has(rb.id)) continue
    out.push(rb)
  }
  return sortByOrder(out)
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
