/**
 * Automerge helpers — Phase C foundation.
 *
 * Wraps `@automerge/automerge` with the small surface the sync layer needs:
 * createDoc / loadDoc / saveDoc / mergeDoc, scoped to the four entity types
 * (task, note, journal, audio).
 *
 * Loaded lazily via dynamic import so the WASM payload (~150KB gz) doesn't
 * block Stage 1 (today + config) render on cold boot. The first call to any
 * helper triggers init; subsequent calls reuse the cached module.
 *
 * No behavior change yet — nothing in the app imports this file. Wiring lands
 * in the per-entity cutover sessions (tasks → notes → journals → audio).
 */

let automergePromise = null

function getAutomerge() {
  if (!automergePromise) {
    automergePromise = import('@automerge/automerge')
  }
  return automergePromise
}

const ENTITY_TYPES = new Set(['task', 'note', 'journal', 'audio'])

function assertType(type) {
  if (!ENTITY_TYPES.has(type)) {
    throw new Error(`automergeDoc: unknown entity type "${type}"`)
  }
}

// Field names on a row that aren't business data — never copied into the
// Automerge document. `_doc` is the Automerge bytes themselves (would create
// a self-reference); everything else is a real persisted field.
const TASK_NON_FIELDS = new Set(['_doc'])
const NOTE_NON_FIELDS = new Set(['_doc', 'body'])
// Per-block fields. `id` is the stable identifier (already used by mergeBlocks
// as the join key); we keep it as a plain string inside Automerge so we can
// look blocks up across devices. `html` is plain text — field-level LWW per
// block matches what mergeBlocks did. `order` is dropped (Automerge.List
// position is the ordering source of truth post-Phase-C).
const NOTE_BLOCK_FIELDS = new Set(['id', 'html', 'deleted', 'updatedAt'])

function shapeTaskFields(source) {
  // Pass-through copy of all task fields except internals. Tasks have been
  // accreting fields over time (dailyReviews, feedback, order, scheduledDate,
  // …) so a fixed schema rots; the doc just holds whatever the row holds.
  // Per-field LWW comes for free from Automerge's internal Lamport clocks.
  const out = {}
  for (const [k, v] of Object.entries(source || {})) {
    if (TASK_NON_FIELDS.has(k)) continue
    out[k] = cloneForAutomerge(v)
  }
  // Mandatory keys so a freshly-seeded doc always has an id/timestamps.
  if (source?.id && !out.id) out.id = source.id
  if (!out.createdAt) out.createdAt = new Date().toISOString()
  if (!out.updatedAt) out.updatedAt = out.createdAt
  return out
}

/**
 * Deep clone primitive/JSON-shaped values so Automerge owns its own copies
 * and can't accidentally share references with the live row.
 */
function cloneForAutomerge(v) {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) return v.map(cloneForAutomerge)
  if (typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = cloneForAutomerge(val)
    return out
  }
  return v
}

function initialShape(type, seed) {
  switch (type) {
    case 'task':
      return shapeTaskFields(seed)
    case 'note':
      return shapeNoteFields(seed)
    case 'journal':
      return {
        date: seed.date,
        blocks: Array.isArray(seed.blocks) ? seed.blocks.map(cloneBlock) : [],
        reviewedAt: seed.reviewedAt ?? null,
        blockComments: seed.blockComments ? { ...seed.blockComments } : {},
        createdAt: seed.createdAt ?? new Date().toISOString(),
        updatedAt: seed.updatedAt ?? new Date().toISOString(),
      }
    case 'audio':
      return {
        id: seed.id,
        mimeType: seed.mimeType ?? '',
        duration: seed.duration ?? 0,
        createdAt: seed.createdAt ?? new Date().toISOString(),
        driveFileId: seed.driveFileId ?? null,
        transcript: seed.transcript ?? '',
        transcriptModel: seed.transcriptModel ?? null,
        transcribedAt: seed.transcribedAt ?? null,
        transcriptSegments: Array.isArray(seed.transcriptSegments)
          ? [...seed.transcriptSegments]
          : [],
        deleted: seed.deleted ?? false,
        deletedAt: seed.deletedAt ?? null,
        sourceType: seed.sourceType ?? null,
        sourceId: seed.sourceId ?? null,
        sourceTitle: seed.sourceTitle ?? null,
      }
    default:
      throw new Error(`automergeDoc: unreachable type "${type}"`)
  }
}

function cloneBlock(b) {
  // `order` from the legacy fractional-index world is intentionally dropped —
  // Automerge.List position is authoritative now. `updatedAt` per-block stays
  // so we can resolve same-block conflicts on materialize if needed; Automerge
  // already gives per-field LWW so this is just a debugging aid.
  return {
    id: b.id,
    html: b.html ?? '',
    deleted: b.deleted ?? false,
    updatedAt: b.updatedAt ?? new Date().toISOString(),
  }
}

/**
 * Build the JSON shape for a note's Automerge doc. Pass-through of business
 * fields (title, tags, createdAt, updatedAt, deleted, deletedAt, ...); blocks
 * are cloned individually to strip `order` and ensure plain values.
 */
function shapeNoteFields(source) {
  const out = {}
  for (const [k, v] of Object.entries(source || {})) {
    if (NOTE_NON_FIELDS.has(k) || k === 'blocks') continue
    out[k] = cloneForAutomerge(v)
  }
  if (source?.id && !out.id) out.id = source.id
  if (!out.title) out.title = ''
  if (!out.createdAt) out.createdAt = new Date().toISOString()
  if (!out.updatedAt) out.updatedAt = out.createdAt
  out.blocks = Array.isArray(source?.blocks) ? source.blocks.map(cloneBlock) : []
  return out
}

export async function createDoc(type, seed) {
  assertType(type)
  const Automerge = await getAutomerge()
  return Automerge.from(initialShape(type, seed))
}

export async function loadDoc(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('automergeDoc.loadDoc: expected Uint8Array')
  }
  const Automerge = await getAutomerge()
  return Automerge.load(bytes)
}

export async function saveDoc(doc) {
  const Automerge = await getAutomerge()
  return Automerge.save(doc)
}

export async function mergeDoc(local, remote) {
  const Automerge = await getAutomerge()
  return Automerge.merge(local, remote)
}

export async function changeDoc(doc, mutator) {
  const Automerge = await getAutomerge()
  return Automerge.change(doc, mutator)
}

/**
 * Apply a task row's fields into an Automerge doc inside a single change.
 * Removes keys no longer present in the source so deletes (e.g. clearing
 * `scheduledDate`) propagate.
 */
export async function applyTaskFields(doc, source) {
  const Automerge = await getAutomerge()
  const fields = shapeTaskFields(source)
  return Automerge.change(doc, (d) => {
    // Remove keys not in source.
    for (const k of Object.keys(d)) {
      if (!(k in fields)) delete d[k]
    }
    // Assign / overwrite. Only mutate when the cloned value differs so we
    // don't churn Automerge history with redundant identical writes.
    for (const [k, v] of Object.entries(fields)) {
      if (!shallowEqual(d[k], v)) d[k] = v
    }
  })
}

function shallowEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!shallowEqual(a[i], b[i])) return false
    return true
  }
  const ak = Object.keys(a), bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (!shallowEqual(a[k], b[k])) return false
  return true
}

/**
 * Apply a note row into its Automerge doc inside a single change. Top-level
 * fields use the same pass-through pattern as tasks. Blocks are reconciled
 * id-keyed against the existing list:
 *  - blocks present on both sides → field-level update in place (keeps the
 *    list position, so Automerge merges other devices' edits stably).
 *  - blocks in source but not in doc → appended to the list in source order.
 *  - blocks in doc but not in source → marked deleted (tombstone) so deletes
 *    propagate; we do not splice, to preserve list-position stability across
 *    devices.
 *  - source order != doc order → list is reordered by splicing in place. This
 *    is the one expensive case; for steady-state editing the editor reports
 *    the same order it received from the previous render and we no-op.
 */
export async function applyNoteFields(doc, source) {
  const Automerge = await getAutomerge()
  const fields = shapeNoteFields(source)
  return Automerge.change(doc, (d) => {
    // Top-level fields (everything except `blocks`).
    for (const k of Object.keys(d)) {
      if (k === 'blocks') continue
      if (!(k in fields)) delete d[k]
    }
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'blocks') continue
      if (!shallowEqual(d[k], v)) d[k] = v
    }

    // Blocks: id-keyed reconcile.
    if (!Array.isArray(d.blocks)) d.blocks = []
    const srcBlocks = fields.blocks
    const srcById = new Map(srcBlocks.map((b) => [b.id, b]))
    const docIds = new Set()

    // Pass 1: update or tombstone existing entries.
    for (let i = 0; i < d.blocks.length; i++) {
      const cur = d.blocks[i]
      if (!cur || !cur.id) continue
      docIds.add(cur.id)
      const src = srcById.get(cur.id)
      if (!src) {
        if (!cur.deleted) {
          cur.deleted = true
          cur.updatedAt = src?.updatedAt || new Date().toISOString()
        }
        continue
      }
      // Per-field update where the value actually changed.
      for (const k of NOTE_BLOCK_FIELDS) {
        if (!shallowEqual(cur[k], src[k])) cur[k] = src[k]
      }
    }

    // Pass 2: append new blocks the doc hasn't seen yet, in source order.
    for (const src of srcBlocks) {
      if (docIds.has(src.id)) continue
      const fresh = {}
      for (const k of NOTE_BLOCK_FIELDS) fresh[k] = src[k]
      d.blocks.push(fresh)
    }

    // Pass 3: if the source-block ordering differs from the doc ordering of
    // the *live* (non-deleted) subset, rewrite the live subset's positions to
    // match. Tombstones stay in place. This is rare in practice — the editor
    // hands us the same order it produced last render.
    const liveSrcOrder = srcBlocks.filter((b) => !b.deleted).map((b) => b.id)
    const liveDocPositions = []
    for (let i = 0; i < d.blocks.length; i++) {
      if (!d.blocks[i].deleted) liveDocPositions.push(i)
    }
    let orderMatches = liveSrcOrder.length === liveDocPositions.length
    if (orderMatches) {
      for (let i = 0; i < liveSrcOrder.length; i++) {
        if (d.blocks[liveDocPositions[i]].id !== liveSrcOrder[i]) { orderMatches = false; break }
      }
    }
    if (!orderMatches) {
      // Splice live entries out (from the end, to keep indices valid), then
      // re-insert in source order at the front. Tombstones float to the back —
      // they don't affect rendering since we filter `deleted` on read, and
      // their list positions no longer carry meaning.
      for (let i = liveDocPositions.length - 1; i >= 0; i--) {
        d.blocks.deleteAt(liveDocPositions[i])
      }
      for (let i = 0; i < liveSrcOrder.length; i++) {
        d.blocks.insertAt(i, pickBlockFields(srcById.get(liveSrcOrder[i]) || {}))
      }
    }
  })
}

function pickBlockFields(b) {
  const out = {}
  for (const k of NOTE_BLOCK_FIELDS) out[k] = b?.[k]
  return out
}

/**
 * Materialize a plain note row from an Automerge note doc.
 */
export function materializeNoteRow(doc) {
  if (!doc) return null
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'blocks') continue
    out[k] = plainCopy(v)
  }
  // Blocks: filter nothing here — the UI's getNotes filters by note-level
  // `deleted`, and block-level tombstones are kept so future merges still
  // see the delete. Strip Automerge proxies; preserve list order.
  out.blocks = Array.isArray(doc.blocks)
    ? doc.blocks.map((b) => {
        const o = {}
        for (const k of NOTE_BLOCK_FIELDS) o[k] = plainCopy(b[k])
        return o
      })
    : []
  return out
}

// Journals reuse the note-block shape (id, html, deleted, updatedAt) — same
// reconcile rules apply (id-keyed update, tombstone-in-place, append new).
const JOURNAL_BLOCK_FIELDS = NOTE_BLOCK_FIELDS
// Top-level journal fields kept distinct from blocks/blockComments so the
// generic copy loop doesn't try to overwrite the structured children.
const JOURNAL_NON_FIELDS = new Set(['_doc', 'blocks', 'blockComments'])
// Per-comment fields. Comments are append-mostly (one entry per blockId in
// practice today, but the schema allows a list). LWW per field via Automerge.
const COMMENT_FIELDS = new Set(['id', 'text', 'createdAt', 'updatedAt'])

function shapeJournalFields(source) {
  const out = {}
  for (const [k, v] of Object.entries(source || {})) {
    if (JOURNAL_NON_FIELDS.has(k)) continue
    out[k] = cloneForAutomerge(v)
  }
  if (source?.date && !out.date) out.date = source.date
  if (!out.createdAt) out.createdAt = new Date().toISOString()
  if (!out.updatedAt) out.updatedAt = out.createdAt
  out.blocks = Array.isArray(source?.blocks) ? source.blocks.map(cloneBlock) : []
  // blockComments: { [blockId]: [{ id, text, createdAt, updatedAt }, ...] }
  const bc = {}
  const srcBc = source?.blockComments || {}
  for (const [bid, list] of Object.entries(srcBc)) {
    if (!Array.isArray(list)) continue
    bc[bid] = list.map(cloneComment)
  }
  out.blockComments = bc
  return out
}

function cloneComment(c) {
  return {
    id: c?.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c_${Math.random().toString(36).slice(2)}`),
    text: c?.text || '',
    createdAt: c?.createdAt || new Date().toISOString(),
    updatedAt: c?.updatedAt || c?.createdAt || new Date().toISOString(),
  }
}

/**
 * Apply a journal day row into its Automerge doc. Blocks are reconciled the
 * same way as notes (id-keyed update / tombstone / append; reorder only when
 * source order disagrees with doc order of the live subset). blockComments is
 * reconciled per blockId: matching comment ids → field-level update; new ids
 * → appended; ids in doc but not in source are LEFT ALONE (we don't tombstone
 * comments — users effectively never delete them, and dropping them would let
 * stale source overwrite a comment another device just added).
 */
export async function applyJournalFields(doc, source) {
  const Automerge = await getAutomerge()
  const fields = shapeJournalFields(source)
  return Automerge.change(doc, (d) => {
    // Top-level fields (everything except blocks + blockComments).
    for (const k of Object.keys(d)) {
      if (k === 'blocks' || k === 'blockComments') continue
      if (!(k in fields)) delete d[k]
    }
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'blocks' || k === 'blockComments') continue
      if (!shallowEqual(d[k], v)) d[k] = v
    }

    // Blocks: same shape as applyNoteFields.
    if (!Array.isArray(d.blocks)) d.blocks = []
    const srcBlocks = fields.blocks
    const srcById = new Map(srcBlocks.map((b) => [b.id, b]))
    const docIds = new Set()

    for (let i = 0; i < d.blocks.length; i++) {
      const cur = d.blocks[i]
      if (!cur || !cur.id) continue
      docIds.add(cur.id)
      const src = srcById.get(cur.id)
      if (!src) {
        if (!cur.deleted) {
          cur.deleted = true
          cur.updatedAt = src?.updatedAt || new Date().toISOString()
        }
        continue
      }
      for (const k of JOURNAL_BLOCK_FIELDS) {
        if (!shallowEqual(cur[k], src[k])) cur[k] = src[k]
      }
    }
    for (const src of srcBlocks) {
      if (docIds.has(src.id)) continue
      const fresh = {}
      for (const k of JOURNAL_BLOCK_FIELDS) fresh[k] = src[k]
      d.blocks.push(fresh)
    }
    const liveSrcOrder = srcBlocks.filter((b) => !b.deleted).map((b) => b.id)
    const liveDocPositions = []
    for (let i = 0; i < d.blocks.length; i++) {
      if (!d.blocks[i].deleted) liveDocPositions.push(i)
    }
    let orderMatches = liveSrcOrder.length === liveDocPositions.length
    if (orderMatches) {
      for (let i = 0; i < liveSrcOrder.length; i++) {
        if (d.blocks[liveDocPositions[i]].id !== liveSrcOrder[i]) { orderMatches = false; break }
      }
    }
    if (!orderMatches) {
      for (let i = liveDocPositions.length - 1; i >= 0; i--) {
        d.blocks.deleteAt(liveDocPositions[i])
      }
      for (let i = 0; i < liveSrcOrder.length; i++) {
        d.blocks.insertAt(i, pickBlockFields(srcById.get(liveSrcOrder[i]) || {}))
      }
    }

    // blockComments: per-blockId reconcile. The source is authoritative for
    // any blockId it mentions — for that blockId we update matching comment
    // ids and append new ones, but never drop ids the source doesn't list
    // (a stale source must not erase a comment another device just made).
    // Blocks in the doc map but not in the source map are left untouched.
    if (!d.blockComments || typeof d.blockComments !== 'object') d.blockComments = {}
    const srcBc = fields.blockComments
    for (const [bid, srcList] of Object.entries(srcBc)) {
      if (!Array.isArray(d.blockComments[bid])) d.blockComments[bid] = []
      const docList = d.blockComments[bid]
      const docIdSet = new Set()
      for (let i = 0; i < docList.length; i++) {
        const cur = docList[i]
        if (cur?.id) docIdSet.add(cur.id)
      }
      const srcById2 = new Map(srcList.map((c) => [c.id, c]))
      for (let i = 0; i < docList.length; i++) {
        const cur = docList[i]
        if (!cur?.id) continue
        const src = srcById2.get(cur.id)
        if (!src) continue
        for (const k of COMMENT_FIELDS) {
          if (!shallowEqual(cur[k], src[k])) cur[k] = src[k]
        }
      }
      for (const src of srcList) {
        if (docIdSet.has(src.id)) continue
        const fresh = {}
        for (const k of COMMENT_FIELDS) fresh[k] = src[k]
        docList.push(fresh)
      }
    }
  })
}

/**
 * Materialize a plain journal row from an Automerge journal doc.
 */
export function materializeJournalRow(doc) {
  if (!doc) return null
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'blocks' || k === 'blockComments') continue
    out[k] = plainCopy(v)
  }
  out.blocks = Array.isArray(doc.blocks)
    ? doc.blocks.map((b) => {
        const o = {}
        for (const k of JOURNAL_BLOCK_FIELDS) o[k] = plainCopy(b[k])
        return o
      })
    : []
  const bc = {}
  const srcBc = doc.blockComments || {}
  for (const [bid, list] of Object.entries(srcBc)) {
    if (!Array.isArray(list)) continue
    bc[bid] = list.map((c) => {
      const o = {}
      for (const k of COMMENT_FIELDS) o[k] = plainCopy(c[k])
      return o
    })
  }
  out.blockComments = bc
  return out
}

/**
 * Materialize a plain row from a task doc. Strips Automerge proxies so the
 * UI/IDB get plain JSON-serializable objects.
 */
export function materializeTaskRow(doc) {
  if (!doc) return null
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    out[k] = plainCopy(v)
  }
  return out
}

function plainCopy(v) {
  if (v == null) return v
  if (Array.isArray(v)) return v.map(plainCopy)
  if (typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = plainCopy(val)
    return out
  }
  return v
}
