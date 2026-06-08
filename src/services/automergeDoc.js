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

const ENTITY_TYPES = new Set(['task', 'note', 'journal', 'audio', 'config'])

function assertType(type) {
  if (!ENTITY_TYPES.has(type)) {
    throw new Error(`automergeDoc: unknown entity type "${type}"`)
  }
}

// Field names on a row that aren't business data — never copied into the
// Automerge document. `_doc` is the Automerge bytes themselves (would create
// a self-reference). `_fts` is the per-field LWW timestamp map (field -> epoch
// ms), an internal sync structure — not a user field — written by
// applyTaskFields and read by mergeTaskLWW. Everything else is a real field.
const TASK_NON_FIELDS = new Set(['_doc', '_fts'])
// Config is a flat key/value map (singleton entity). `_doc` is the only
// non-business field; everything else is a real setting.
const CONFIG_NON_FIELDS = new Set(['_doc'])
// `_fts` is the per-field LWW timestamp map (same as tasks — see TASK_NON_FIELDS).
const NOTE_NON_FIELDS = new Set(['_doc', 'body', '_fts'])
// Per-block fields. `id` is the stable identifier (the join key across devices).
// `html` is the content (field-level LWW per block). `order` is a fractional-
// index key (see blocks.js fiBetween): ordering is carried by this FIELD, not by
// the Automerge list's physical position. This is deliberate — reordering by
// splicing the Automerge list (deleteAt/insertAt) duplicates blocks under
// concurrent edits, because list elements have structural identity that the `id`
// field can't override. So the list is APPEND-ONLY; we sort by `order` on read.
const NOTE_BLOCK_FIELDS = new Set(['id', 'html', 'deleted', 'updatedAt', 'order'])

/**
 * Build the JSON shape for the config singleton's Automerge doc. Pass-through
 * of every setting key (groqApiKey, groqModel, syncInterval, dayRollover*, …);
 * the schema isn't fixed so new settings flow through without code changes.
 * `updatedAt` is stamped so disjoint-root docs can be resolved by recency.
 */
function shapeConfigFields(source) {
  const out = {}
  for (const [k, v] of Object.entries(source || {})) {
    if (CONFIG_NON_FIELDS.has(k)) continue
    out[k] = cloneForAutomerge(v)
  }
  if (!out.updatedAt) out.updatedAt = new Date().toISOString()
  return out
}

function shapeTaskFields(source) {
  // Pass-through copy of all task fields except internals. Tasks have been
  // accreting fields over time (dailyReviews, feedback, order, …) so a fixed
  // schema rots; the doc just holds whatever the row holds.
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
    case 'config':
      return shapeConfigFields(seed)
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
  // `order` is the fractional-index sort key — KEPT (not dropped). Ordering lives
  // in this field; the Automerge list is append-only and sorted by `order` on
  // read. `updatedAt` per-block stays for per-field LWW debugging.
  return {
    id: b.id,
    html: b.html ?? '',
    deleted: b.deleted ?? false,
    updatedAt: b.updatedAt ?? new Date().toISOString(),
    order: b.order ?? null,
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

/**
 * True if two docs share at least one change in their history (i.e. they
 * descend from a common root and `Automerge.merge` will correctly combine
 * them). Two docs each created independently with `Automerge.from` have
 * DISJOINT roots — merging them silently drops one side's list/map content.
 * Callers use this to detect that case and re-base on the remote instead.
 */
export async function sharesAncestry(a, b) {
  const Automerge = await getAutomerge()
  try {
    const aHashes = new Set(Automerge.getAllChanges(a).map(c => Automerge.decodeChange(c).hash))
    for (const c of Automerge.getAllChanges(b)) {
      if (aHashes.has(Automerge.decodeChange(c).hash)) return true
    }
    return false
  } catch {
    // If the Automerge build doesn't expose these, assume shared ancestry so we
    // fall back to the prior (merge-only) behavior rather than over-adopting.
    return true
  }
}

export async function changeDoc(doc, mutator) {
  const Automerge = await getAutomerge()
  return Automerge.change(doc, mutator)
}

/**
 * Apply a task row's fields into an Automerge doc inside a single change.
 * Removes keys no longer present in the source so deletes (e.g. clearing
 * `feedback`) propagate.
 */
export async function applyTaskFields(doc, source) {
  const Automerge = await getAutomerge()
  const fields = shapeTaskFields(source)
  return Automerge.change(doc, (d) => stampLWW(d, fields, source))
}

/**
 * Per-field wall-clock LWW merge of two shared-ancestry task docs. See
 * lwwMergeFields for the full rationale (the bare-Automerge.merge actor-id bug).
 */
export async function mergeTaskLWW(localDoc, remoteDoc) {
  const Automerge = await getAutomerge()
  const merged = Automerge.merge(Automerge.clone(localDoc), remoteDoc)
  return Automerge.change(merged, (d) => lwwMergeFields(d, localDoc, remoteDoc))
}

/**
 * Re-assert the live IndexedDB ROW's authority over a just-merged doc.
 *
 * A task/note is stored as two views of one record: the plain ROW (owned by the
 * UI write path, updateTask/putNote) and the Automerge `_doc` bytes (owned by
 * the push path, which re-serializes the row via applyFields and stamps `_fts`).
 * updateTask writes ONLY the row and defers doc serialization to pushTasks — so
 * for a window the row is NEWER than the doc. A poll-merge that lands in that
 * window reads the STALE doc, and even a correct per-field LWW merge can only
 * pick between two values that are both behind the live row. Materializing that
 * merge back over the row then reverts the user's edit (status flips back, typed
 * text vanishes, updatedAt runs backwards — the live single-device regression).
 *
 * The dirty flag can't gate this reliably: pushTasks calls clearDirty() before
 * the racing poll-merge reads the dirty set, so the guard misses. The correct,
 * timing-independent invariant is data-authority, not scheduling: the ROW is
 * authoritative for its owned fields until the doc catches up. So if the live
 * row is strictly newer than the merged doc, re-fold the row onto the merge
 * (applyFields stamps `_fts` at the row's clock, so the edit also wins the next
 * cross-device merge and pushTasks ships it). If the doc is current or ahead —
 * the normal case, where push already serialized a newer state and the row is
 * just a stale read — leave the merge untouched.
 *
 * `applyFields` is the type's row->doc serializer (applyTaskFields/applyNoteFields);
 * `materialize` reads the merged doc's updatedAt for the recency compare.
 */
export async function reconcileLiveRow(mergedDoc, liveRow, applyFields, materialize) {
  if (!liveRow) return mergedDoc
  const rowUpd = new Date(liveRow.updatedAt || 0).getTime()
  const docUpd = new Date(materialize(mergedDoc)?.updatedAt || 0).getTime()
  // Strictly newer row = an unserialized local edit the merge couldn't see.
  // Equal/older row = doc is current or ahead; nothing to re-assert.
  if (rowUpd <= docUpd) return mergedDoc
  return applyFields(mergedDoc, liveRow)
}

/**
 * Write side of per-field wall-clock LWW. Records, per field, the wall-clock
 * time it last actually changed in `_fts`, so the merge side (lwwMergeFields)
 * can keep the value whose `_fts` is newest — Automerge's own conflict
 * resolution is by actor-id, NOT time, so a plain merge can revert a newer
 * concurrent edit (and `updatedAt` runs backwards). Runs INSIDE an
 * Automerge.change on doc `d`; `fields` is the shaped business-field map;
 * `source` supplies the wall clock (updatedAt) and the stable createdAt floor.
 * `skipKeys` lists fields whose conflict resolution is NOT scalar LWW (e.g. a
 * note's `blocks` list, merged by Automerge's own id-keyed reconcile) — they're
 * still assigned, just not stamped/LWW-resolved.
 */
function stampLWW(d, fields, source, skipKeys = null) {
  // Use the row's own updatedAt (stable across re-pushes of the same edit),
  // falling back to now for a fresh edit with no clock.
  const stamp = ((t) => Number.isFinite(t) && t > 0 ? t : Date.now())(
    new Date(source?.updatedAt || 0).getTime()
  )
  // Floor for fields that exist but have never been individually stamped (legacy
  // docs, or fields untouched since creation). MUST be stable + identical on
  // every device — otherwise an untouched field would look freshly-written on
  // one branch and wrongly win a merge. `createdAt` is set once at creation and
  // shared via the common Automerge ancestor. Clamp to `stamp` so a (mis)dated
  // future createdAt can't out-rank a real edit.
  const floor = Math.min(
    stamp,
    ((t) => Number.isFinite(t) && t > 0 ? t : 0)(new Date(source?.createdAt || 0).getTime())
  )
  if (!d._fts) d._fts = {}
  // Remove keys not in source. Stamp the deletion with `stamp` so a delete
  // (e.g. clearing `feedback`) wins over a concurrent older edit by recency.
  for (const k of Object.keys(d)) {
    if (k === '_fts' || (skipKeys && skipKeys.has(k))) continue
    if (!(k in fields)) {
      delete d[k]
      d._fts[k] = stamp
    }
  }
  // Assign / overwrite. Only mutate (and bump `_fts`) when the value actually
  // changed — an untouched field keeps its existing stamp so it can't beat a
  // real concurrent edit. Fields with no stamp yet get the stable `floor`.
  for (const [k, v] of Object.entries(fields)) {
    if (skipKeys && skipKeys.has(k)) continue
    if (!shallowEqual(d[k], v)) {
      d[k] = v
      d._fts[k] = stamp
    } else if (d._fts[k] == null) {
      d._fts[k] = floor
    }
  }
}

/**
 * Merge side of per-field wall-clock LWW. Replaces a bare `Automerge.merge`,
 * which resolves each concurrent scalar by actor-id order (not time) — so a
 * genuinely newer edit can lose, and `updatedAt` can resolve to a different
 * actor than the field that "won", running backwards and corrupting the
 * disjoint-root tiebreak on the next device.
 *
 * The caller `Automerge.merge`s for history convergence first; this then runs
 * INSIDE a follow-up Automerge.change on the merged doc `d`, overwriting each
 * field with the value from whichever PARENT's `_fts[field]` is newer. Reading
 * from the parents (not `d`) is what makes it desync-proof: `d` may have
 * collapsed `field` and `_fts[field]` to different actors, but each parent's
 * pair is internally consistent. Fields untouched on a branch carry their
 * ancestor stamp (or `createdAt` floor), so they never beat a real edit. Ties
 * go to remote (stable, matches newerDoc). Both devices compare the same two
 * parents → converge to an identical doc. `skipKeys` (e.g. a note's `blocks`)
 * are left exactly as Automerge.merge produced them.
 */
function lwwMergeFields(d, localDoc, remoteDoc, skipKeys = null) {
  const lf = localDoc._fts || {}
  const rf = remoteDoc._fts || {}
  const lFloor = new Date(localDoc.createdAt || 0).getTime()
  const rFloor = new Date(remoteDoc.createdAt || 0).getTime()
  const lUpd = new Date(localDoc.updatedAt || 0).getTime()
  const rUpd = new Date(remoteDoc.updatedAt || 0).getTime()
  const keys = new Set(
    [...Object.keys(localDoc), ...Object.keys(remoteDoc)].filter(
      k => k !== '_fts' && !(skipKeys && skipKeys.has(k))
    )
  )
  if (!d._fts) d._fts = {}
  for (const k of keys) {
    // Per-field stamp; fall back to the branch's createdAt floor, never to
    // updatedAt (that would make every untouched field look freshly written).
    const lt = lf[k] ?? lFloor
    const rt = rf[k] ?? rFloor
    const localWins = lt > rt // tie -> remote
    const winner = localWins ? localDoc : remoteDoc
    const wt = localWins ? lt : rt
    if (k in winner) {
      const v = cloneForAutomerge(winner[k])
      if (!shallowEqual(d[k], v)) d[k] = v
    } else if (k in d) {
      delete d[k] // winner deleted this field
    }
    if (d._fts[k] !== wt) d._fts[k] = wt
  }
  // updatedAt is a field too, but make sure the row clock never goes backwards
  // relative to either parent — it's the disjoint-root tiebreak key elsewhere.
  const newestUpd = Math.max(lUpd, rUpd)
  if (new Date(d.updatedAt || 0).getTime() < newestUpd) {
    d.updatedAt = new Date(newestUpd).toISOString()
  }
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
 * Collapse duplicate physical list elements that share a block `id` down to a
 * single live element, IN PLACE inside an Automerge.change.
 *
 * The block list is append-only and reconciled by `id`: Pass-1 assumes at most
 * one physical element per id. Older bugs (and the audio re-id migration) left
 * the list holding several physical elements with the SAME id. The editor
 * dedupes by id on read, so the user sees one block, deletes it, and the single
 * tombstone never neutralizes the other physical copies — they re-materialize
 * (the un-deletable duplicate-audio bug).
 *
 * We CANNOT splice/deleteAt to remove them (concurrent splices re-duplicate —
 * the original doubled-block bug). Instead we tombstone the surplus copies in
 * place: keep the first live element per id, mark every other physical element
 * with that id `deleted: true`. Idempotent, splice-free, converges on every
 * device, and heals existing corruption on the next write. Mutates `blocks`.
 */
function collapseDuplicateBlockIds(blocks) {
  const liveSeen = new Set()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b || !b.id || b.deleted) continue
    if (liveSeen.has(b.id)) {
      b.deleted = true // surplus live copy of an id we already kept
    } else {
      liveSeen.add(b.id)
    }
  }
}

/**
 * Read-side counterpart to collapseDuplicateBlockIds. The write-side collapse
 * only runs inside applyNote/JournalFields (i.e. on a local push). The MERGE
 * path (Automerge.merge of two docs that share ancestry, journalMerge/sync.js)
 * does NOT go through it — it combines raw bytes — so a doc carrying several
 * live physical elements with the same id will re-materialize all of them after
 * every pull, and the user's delete keeps "coming back". This filters the
 * surplus LIVE copies out of the materialized row on EVERY read, regardless of
 * which path produced the doc, so the UI is always correct on the first render
 * with no write required. Tombstones (deleted:true) are left untouched and kept
 * in the output — merges still need to see the delete. Operates on already-
 * mapped plain block objects; preserves their order.
 */
function dedupeLiveBlocksById(blocks) {
  const liveSeen = new Set()
  const out = []
  for (const b of blocks) {
    if (b && b.id && !b.deleted) {
      if (liveSeen.has(b.id)) continue // drop surplus live copy
      liveSeen.add(b.id)
    }
    out.push(b)
  }
  return out
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
const NOTE_LWW_SKIP = new Set(['blocks'])

export async function applyNoteFields(doc, source) {
  const Automerge = await getAutomerge()
  const fields = shapeNoteFields(source)
  return Automerge.change(doc, (d) => {
    // Top-level scalar fields (title, tags, deleted, …): per-field wall-clock
    // LWW, same as tasks. `blocks` is skipped — it's a CRDT list reconciled by
    // the id-keyed passes below + Automerge merge, NOT scalar LWW.
    stampLWW(d, fields, source, NOTE_LWW_SKIP)

    // Blocks: id-keyed reconcile.
    if (!Array.isArray(d.blocks)) d.blocks = []
    // Pass 0: collapse any pre-existing duplicate-id physical elements to one
    // live each, so Pass-1's one-element-per-id assumption holds and deletes of
    // a duplicated block actually stick.
    collapseDuplicateBlockIds(d.blocks)
    const srcBlocks = fields.blocks
    const srcById = new Map(srcBlocks.map((b) => [b.id, b]))
    const docIds = new Set()

    // Pass 1: update existing entries in place (including `order`). We do NOT
    // tombstone a doc block that the source row simply doesn't mention — the
    // editor snapshot can lag the merged doc, and treating "absent" as "deleted"
    // is the cross-device block-loss bug. Genuine deletes arrive as an explicit
    // { deleted: true } source entry (stampBlocksFromDoc tombstones removed
    // blocks) and flow through this same per-field update.
    for (let i = 0; i < d.blocks.length; i++) {
      const cur = d.blocks[i]
      if (!cur || !cur.id) continue
      docIds.add(cur.id)
      const src = srcById.get(cur.id)
      if (!src) continue
      for (const k of NOTE_BLOCK_FIELDS) {
        if (!shallowEqual(cur[k], src[k])) cur[k] = src[k]
      }
    }

    // Pass 2: append new blocks the doc hasn't seen yet. The list is APPEND-ONLY
    // — order is carried by each block's `order` field and applied on read via
    // sortByOrder. We never deleteAt/insertAt to reorder: under concurrent edits
    // that re-inserts list elements Automerge can't dedupe by our `id` field, so
    // merge keeps both copies (the doubled-paragraph duplication bug). Ordering
    // changes are just `order` field updates handled in Pass 1.
    for (const src of srcBlocks) {
      if (docIds.has(src.id)) continue
      const fresh = {}
      for (const k of NOTE_BLOCK_FIELDS) fresh[k] = src[k]
      d.blocks.push(fresh)
    }
  })
}

/**
 * Per-field wall-clock LWW merge of two shared-ancestry note docs. Same fix as
 * mergeTaskLWW (bare Automerge.merge resolves scalars by actor-id, not time, so
 * a newer edit reverts). `blocks` is left to Automerge's own merge — the
 * append-only + id-keyed-reconcile machinery (see applyNoteFields) is the
 * correct CRDT resolution for the note body; overwriting it wholesale by LWW
 * would reintroduce the block-loss/duplication bug. Only scalar fields (title,
 * tags, deleted, …) get per-field LWW.
 */
export async function mergeNoteLWW(localDoc, remoteDoc) {
  const Automerge = await getAutomerge()
  const merged = Automerge.merge(Automerge.clone(localDoc), remoteDoc)
  return Automerge.change(merged, (d) => lwwMergeFields(d, localDoc, remoteDoc, NOTE_LWW_SKIP))
}

/**
 * Sort materialized blocks by their fractional-index `order` key (id tiebreak,
 * matching blocks.js sortByOrder so HTML and row order agree). The Automerge
 * list is append-only, so its physical order is meaningless — `order` is the
 * source of truth.
 *
 * Legacy docs predate the `order` field: their blocks have order == null. To
 * avoid scrambling existing content, we backfill a temporary order from each
 * block's current list position BEFORE sorting, so a doc that's never been
 * re-stamped renders in exactly the order it's stored in today. The first real
 * edit persists proper fractional keys via stampBlocksFromDoc.
 */
function sortBlocksByOrder(blocks) {
  // Mixed/partial migration is the only ambiguous case. Resolve it by tier:
  //   - every block keyed   → sort by fractional `order` (id tiebreak).
  //   - none keyed (legacy) → keep current Automerge list position (backfill
  //     from position; first re-stamp persists real keys).
  //   - some keyed (mid-migration) → keep list position too. Interleaving a
  //     half-stamped doc by a comparator that mixes keys and positions isn't a
  //     total order; staying with the stored list order is stable and matches
  //     what the user sees today. The next full save stamps everyone.
  const allKeyed = blocks.every(b => b.order != null)
  if (!allKeyed) return blocks.slice()
  return blocks.slice().sort((a, b) => {
    if (a.order < b.order) return -1
    if (a.order > b.order) return 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Materialize a plain note row from an Automerge note doc.
 */
export function materializeNoteRow(doc) {
  if (!doc) return null
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'blocks' || k === '_fts') continue
    out[k] = plainCopy(v)
  }
  // Blocks: filter nothing here — the UI's getNotes filters by note-level
  // `deleted`, and block-level tombstones are kept so future merges still see
  // the delete. Strip Automerge proxies, then sort by `order` (the append-only
  // list's physical position is meaningless).
  out.blocks = Array.isArray(doc.blocks)
    ? sortBlocksByOrder(dedupeLiveBlocksById(doc.blocks.map((b) => {
        const o = {}
        for (const k of NOTE_BLOCK_FIELDS) o[k] = plainCopy(b[k])
        return o
      })))
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
    // Pass 0: collapse duplicate-id physical elements (see applyNoteFields).
    collapseDuplicateBlockIds(d.blocks)
    const srcBlocks = fields.blocks
    const srcById = new Map(srcBlocks.map((b) => [b.id, b]))
    const docIds = new Set()

    // Pass 1: update existing entries in place (incl. `order`). A doc block the
    // source row doesn't mention is NOT tombstoned — the editor snapshot can lag
    // the merged doc, and "absent" must not mean "deleted" (the block-loss bug).
    // Genuine deletes arrive as explicit { deleted: true } source entries.
    for (let i = 0; i < d.blocks.length; i++) {
      const cur = d.blocks[i]
      if (!cur || !cur.id) continue
      docIds.add(cur.id)
      const src = srcById.get(cur.id)
      if (!src) continue
      for (const k of JOURNAL_BLOCK_FIELDS) {
        if (!shallowEqual(cur[k], src[k])) cur[k] = src[k]
      }
    }
    // Pass 2: append new blocks only. The list is APPEND-ONLY; ordering is the
    // `order` field, applied via sortByOrder on read. We never deleteAt/insertAt
    // to reorder — concurrent splices duplicate blocks Automerge can't dedupe by
    // our `id` field (the doubled-paragraph bug). Reorders are `order` updates
    // handled in Pass 1.
    for (const src of srcBlocks) {
      if (docIds.has(src.id)) continue
      const fresh = {}
      for (const k of JOURNAL_BLOCK_FIELDS) fresh[k] = src[k]
      d.blocks.push(fresh)
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
    ? sortBlocksByOrder(dedupeLiveBlocksById(doc.blocks.map((b) => {
        const o = {}
        for (const k of JOURNAL_BLOCK_FIELDS) o[k] = plainCopy(b[k])
        return o
      })))
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
 * UI/IDB get plain JSON-serializable objects. `_fts` (per-field LWW stamps) is
 * an internal in-doc structure — not a row field — so it's dropped here; it
 * lives only inside the Automerge bytes and is read back via mergeTaskLWW.
 */
export function materializeTaskRow(doc) {
  if (!doc) return null
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_fts') continue
    out[k] = plainCopy(v)
  }
  return out
}

/**
 * Apply the config row's fields into its Automerge doc inside a single change.
 * Mirrors applyTaskFields: removes keys no longer present in the source (so a
 * cleared setting propagates), assigns changed keys. `updatedAt` is bumped when
 * anything actually changed so the disjoint-root heal (newerDoc) has a clock.
 */
export async function applyConfigFields(doc, source) {
  const Automerge = await getAutomerge()
  const fields = shapeConfigFields(source)
  return Automerge.change(doc, (d) => {
    let changed = false
    for (const k of Object.keys(d)) {
      if (k === 'updatedAt') continue
      if (!(k in fields)) { delete d[k]; changed = true }
    }
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'updatedAt') continue
      if (!shallowEqual(d[k], v)) { d[k] = v; changed = true }
    }
    if (changed || !d.updatedAt) d.updatedAt = new Date().toISOString()
  })
}

/**
 * Materialize a plain config row from a config Automerge doc.
 */
export function materializeConfigRow(doc) {
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
