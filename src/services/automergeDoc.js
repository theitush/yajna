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

// Field names on a task row that aren't business data — never copied into the
// Automerge document. `_doc` is the Automerge bytes themselves (would create
// a self-reference); everything else is a real persisted field.
const TASK_NON_FIELDS = new Set(['_doc'])

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
      return {
        id: seed.id,
        title: seed.title ?? '',
        blocks: Array.isArray(seed.blocks) ? seed.blocks.map(cloneBlock) : [],
        deleted: seed.deleted ?? false,
        createdAt: seed.createdAt ?? new Date().toISOString(),
        updatedAt: seed.updatedAt ?? new Date().toISOString(),
      }
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
  return {
    id: b.id,
    html: b.html ?? '',
    order: b.order ?? 0,
    deleted: b.deleted ?? false,
  }
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
