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

function initialShape(type, seed) {
  switch (type) {
    case 'task':
      return {
        id: seed.id,
        title: seed.title ?? '',
        done: seed.done ?? false,
        dueDate: seed.dueDate ?? null,
        tags: Array.isArray(seed.tags) ? [...seed.tags] : [],
        deleted: seed.deleted ?? false,
        createdAt: seed.createdAt ?? new Date().toISOString(),
        updatedAt: seed.updatedAt ?? new Date().toISOString(),
      }
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
