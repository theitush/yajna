import { openDB } from 'idb'
import {
  DB_NAME, DB_VERSION,
  STORE_TASKS, STORE_NOTES, STORE_JOURNALS, STORE_CONFIG, STORE_META, STORE_AUDIO, STORE_REVIEWS,
} from '../lib/constants'

let dbPromise = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains(STORE_TASKS)) {
          db.createObjectStore(STORE_TASKS, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          db.createObjectStore(STORE_NOTES, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORE_CONFIG)) {
          db.createObjectStore(STORE_CONFIG)
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META)
        }
        if (!db.objectStoreNames.contains(STORE_AUDIO)) {
          db.createObjectStore(STORE_AUDIO, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORE_REVIEWS)) {
          db.createObjectStore(STORE_REVIEWS)
        }

        // Journals: weekly docs (keyPath 'week') → per-day docs (keyPath 'date').
        // v4 migration: read existing weekly rows, split each `entries[date]` into
        // its own row, fold STORE_REVIEWS entries into matching day's reviewedAt,
        // then recreate the store with the new keyPath.
        if (!db.objectStoreNames.contains(STORE_JOURNALS)) {
          db.createObjectStore(STORE_JOURNALS, { keyPath: 'date' })
        } else if (oldVersion < 4) {
          // Collect prior weekly docs and the global reviews index using the
          // current upgrade transaction, then drop+recreate the store.
          const oldStore = tx.objectStore(STORE_JOURNALS)
          const weeklyDocs = await oldStore.getAll()
          let reviewsIndex = {}
          if (db.objectStoreNames.contains(STORE_REVIEWS)) {
            try {
              const rev = await tx.objectStore(STORE_REVIEWS).get('index')
              if (rev && typeof rev === 'object') reviewsIndex = rev
            } catch {}
          }

          db.deleteObjectStore(STORE_JOURNALS)
          const newStore = db.createObjectStore(STORE_JOURNALS, { keyPath: 'date' })

          for (const weekly of weeklyDocs || []) {
            const entries = weekly?.entries || {}
            for (const [date, entry] of Object.entries(entries)) {
              if (!date || !entry) continue
              const dayDoc = {
                date,
                blocks: Array.isArray(entry.blocks) ? entry.blocks : [],
                reviewedAt: entry.reviewedAt || null,
                blockComments: entry.blockComments || {},
                createdAt: entry.createdAt || entry.updatedAt || new Date().toISOString(),
                updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
              }
              newStore.put(dayDoc)
            }
          }

          // Fold reviews index into any day docs we just wrote (or create
          // stubs for dates that only had a review marker but no journal).
          for (const [date, reviewedAt] of Object.entries(reviewsIndex || {})) {
            if (!date || !reviewedAt) continue
            const existing = await newStore.get(date)
            if (existing) {
              const winnerTs = (existing.reviewedAt && existing.reviewedAt > reviewedAt)
                ? existing.reviewedAt
                : reviewedAt
              newStore.put({ ...existing, reviewedAt: winnerTs })
            } else {
              newStore.put({
                date,
                blocks: [],
                reviewedAt,
                blockComments: {},
                createdAt: reviewedAt,
                updatedAt: reviewedAt,
              })
            }
          }
        }
      },
    })
  }
  return dbPromise
}

// Tasks
// Reads filter out tombstones so the UI never sees soft-deleted rows. Also
// strip the Phase C `_doc` Uint8Array (Automerge bytes) — the UI doesn't need
// it and serializing it through zustand/React would just bloat snapshots.
// Tombstones still live in IDB/Drive so multi-device sync knows about the delete.
function stripDoc(row) {
  if (!row || !row._doc) return row
  const { _doc, ...rest } = row
  return rest
}

export async function getTasks() {
  const db = await getDB()
  const all = await db.getAll(STORE_TASKS)
  return all.filter(t => !t.deleted).map(stripDoc)
}

export async function getAllTasksRaw() {
  const db = await getDB()
  const all = await db.getAll(STORE_TASKS)
  return all.map(stripDoc)
}

export async function getTask(id) {
  const db = await getDB()
  return stripDoc(await db.get(STORE_TASKS, id))
}

/**
 * Phase C: per-task Automerge document bytes live alongside the materialized
 * row under the `_doc` key. These helpers read/write just the bytes without
 * disturbing the row (or vice versa) so push/pull can stage updates safely.
 */
export async function getTaskDocBytes(id) {
  const db = await getDB()
  const row = await db.get(STORE_TASKS, id)
  return row?._doc instanceof Uint8Array ? row._doc : null
}

export async function putTaskDocBytes(id, bytes) {
  if (!id || !(bytes instanceof Uint8Array)) return
  const db = await getDB()
  const existing = await db.get(STORE_TASKS, id)
  await db.put(STORE_TASKS, { ...(existing || { id }), _doc: bytes })
}

/**
 * Atomically replace both the materialized row and its Automerge bytes. Used
 * by the pull path so a partial write can't leave the row pointing at a doc
 * version it doesn't reflect. Mirrors putTask's dirty-marking behavior.
 */
export async function putTaskWithDoc(task, bytes, opts) {
  if (!task?.id) return
  const db = await getDB()
  const next = bytes instanceof Uint8Array ? { ...task, _doc: bytes } : task
  await db.put(STORE_TASKS, next)
  if (!opts?.fromSync) await markDirty('task', task.id)
}

export async function putTask(task, opts) {
  if (!task?.id) return
  const db = await getDB()
  // Preserve any `_doc` bytes already on the row — UI write paths read tasks
  // via stripDoc and then pass the result back in, which would otherwise drop
  // the Automerge bytes. The push pipeline always wins over this preserve via
  // putTaskWithDoc.
  let next = task
  if (!(task._doc instanceof Uint8Array)) {
    const existing = await db.get(STORE_TASKS, task.id)
    if (existing?._doc instanceof Uint8Array) next = { ...task, _doc: existing._doc }
  }
  await db.put(STORE_TASKS, next)
  if (!opts?.fromSync) await markDirty('task', task.id)
}

export async function putTasks(tasks, opts) {
  const db = await getDB()
  const tx = db.transaction(STORE_TASKS, 'readwrite')
  // Same preserve-existing-_doc rule as putTask. We read inside the same tx so
  // a concurrent write can't slip between the get and put.
  await Promise.all([
    ...tasks.map(async (t) => {
      if (!t?.id) return
      let next = t
      if (!(t._doc instanceof Uint8Array)) {
        const existing = await tx.store.get(t.id)
        if (existing?._doc instanceof Uint8Array) next = { ...t, _doc: existing._doc }
      }
      return tx.store.put(next)
    }),
    tx.done,
  ])
  if (opts?.fromSync) return
  for (const t of tasks) if (t?.id) await markDirty('task', t.id)
}

// Soft-delete: writes a tombstone (deleted: true + deletedAt) so the delete
// propagates via sync. Pass a minimal object to avoid keeping stale content.
export async function deleteTask(id) {
  const db = await getDB()
  const now = new Date().toISOString()
  await db.put(STORE_TASKS, { id, deleted: true, deletedAt: now, updatedAt: now })
  await markDirty('task', id)
}

// Notes
export async function getNotes() {
  const db = await getDB()
  const all = await db.getAll(STORE_NOTES)
  return all.filter(n => !n.deleted).map(stripDoc)
}

export async function getAllNotesRaw() {
  const db = await getDB()
  const all = await db.getAll(STORE_NOTES)
  return all.map(stripDoc)
}

/**
 * Phase C: per-note Automerge document bytes live alongside the materialized
 * row under the `_doc` key. Same shape as task doc bytes.
 */
export async function getNoteDocBytes(id) {
  const db = await getDB()
  const row = await db.get(STORE_NOTES, id)
  return row?._doc instanceof Uint8Array ? row._doc : null
}

export async function putNoteDocBytes(id, bytes) {
  if (!id || !(bytes instanceof Uint8Array)) return
  const db = await getDB()
  const existing = await db.get(STORE_NOTES, id)
  await db.put(STORE_NOTES, { ...(existing || { id }), _doc: bytes })
}

export async function putNoteWithDoc(note, bytes, opts) {
  if (!note?.id) return
  const db = await getDB()
  const next = bytes instanceof Uint8Array ? { ...note, _doc: bytes } : note
  await db.put(STORE_NOTES, next)
  if (!opts?.fromSync) await markDirty('note', note.id)
}

export async function putNote(note, opts) {
  if (!note?.id) return
  const db = await getDB()
  // Same preserve-existing-_doc rule as putTask — UI write paths read via
  // stripDoc and pass back a row without `_doc`; preserve whatever bytes were
  // already there so we don't blow away the local Automerge state.
  let next = note
  if (!(note._doc instanceof Uint8Array)) {
    const existing = await db.get(STORE_NOTES, note.id)
    if (existing?._doc instanceof Uint8Array) next = { ...note, _doc: existing._doc }
  }
  await db.put(STORE_NOTES, next)
  if (!opts?.fromSync) await markDirty('note', note.id)
}

export async function putNotes(notes, opts) {
  const db = await getDB()
  const tx = db.transaction(STORE_NOTES, 'readwrite')
  await Promise.all([
    ...notes.map(async (n) => {
      if (!n?.id) return
      let next = n
      if (!(n._doc instanceof Uint8Array)) {
        const existing = await tx.store.get(n.id)
        if (existing?._doc instanceof Uint8Array) next = { ...n, _doc: existing._doc }
      }
      return tx.store.put(next)
    }),
    tx.done,
  ])
  if (opts?.fromSync) return
  for (const n of notes) if (n?.id) await markDirty('note', n.id)
}

export async function deleteNote(id) {
  const db = await getDB()
  const now = new Date().toISOString()
  await db.put(STORE_NOTES, { id, deleted: true, deletedAt: now, updatedAt: now })
  await markDirty('note', id)
}

// Purge tombstones that the user has explicitly purged from Trash. We only
// hard-delete rows the user asked to delete forever — everything else lives
// in Trash indefinitely until the user manually clears it. The cutoff gives
// every device a grace window to see the purge marker before we drop the row.
export async function purgeTombstones(cutoffIso) {
  const db = await getDB()
  for (const store of [STORE_TASKS, STORE_NOTES]) {
    const tx = db.transaction(store, 'readwrite')
    const all = await tx.store.getAll()
    for (const row of all) {
      if (row.deleted && row.purged && row.deletedAt && row.deletedAt < cutoffIso) {
        await tx.store.delete(row.id)
      }
    }
    await tx.done
  }
}

// Journals: per-day docs keyed by 'date' (YYYY-MM-DD).
// Shape: { date, blocks, reviewedAt, blockComments, createdAt, updatedAt }
export async function getJournal(date) {
  const db = await getDB()
  return db.get(STORE_JOURNALS, date)
}

export async function putJournal(dayDoc) {
  const db = await getDB()
  return db.put(STORE_JOURNALS, dayDoc)
}

export async function getAllJournals() {
  const db = await getDB()
  return db.getAll(STORE_JOURNALS)
}

// Config
export async function getConfig() {
  const db = await getDB()
  return db.get(STORE_CONFIG, 'config') || {}
}

export async function putConfig(config) {
  const db = await getDB()
  return db.put(STORE_CONFIG, config, 'config')
}

// Audio: local-first audio blob store. Each record is
// { id, blob, mimeType, duration, createdAt, driveFileId? }
export async function putAudio(record, opts) {
  const db = await getDB()
  await db.put(STORE_AUDIO, record)
  if (record?.id && !opts?.fromSync) await markDirty('audio', record.id)
}

export async function getAudio(id) {
  const db = await getDB()
  return db.get(STORE_AUDIO, id)
}

export async function getAllAudio() {
  const db = await getDB()
  return db.getAll(STORE_AUDIO)
}

export async function deleteAudio(id) {
  const db = await getDB()
  return db.delete(STORE_AUDIO, id)
}

// Meta (sync timestamps, drive folder id, etc.)
export async function getMeta(key) {
  const db = await getDB()
  return db.get(STORE_META, key)
}

export async function putMeta(key, value) {
  const db = await getDB()
  return db.put(STORE_META, value, key)
}

/**
 * Per-entity dirty tracking for Phase B push path. The bulk push helpers
 * (`pushTasks`/`pushNotes`/etc) no longer rewrite the entire array — they
 * drain this set and push only the touched ids, then append a single manifest
 * batch. Keyed in meta as `dirty_<type>` → { [id]: true }.
 *
 * Race-safe by virtue of how it's used: `markDirty` is called *before* the
 * push fires (puts inside store actions, push scheduled via withRetry). If a
 * push completes and then another mutation happens, the next push picks the
 * new id up. The `clearDirty(ids)` call only removes the ids we just pushed,
 * so a write that landed mid-push survives into the next round.
 */
export async function markDirty(type, id) {
  if (!id) return
  const db = await getDB()
  const key = `dirty_${type}`
  const current = (await db.get(STORE_META, key)) || {}
  if (current[id]) return
  current[id] = true
  await db.put(STORE_META, current, key)
}

export async function getDirty(type) {
  const db = await getDB()
  return (await db.get(STORE_META, `dirty_${type}`)) || {}
}

export async function clearDirty(type, ids) {
  if (!ids?.length) return
  const db = await getDB()
  const key = `dirty_${type}`
  const current = (await db.get(STORE_META, key)) || {}
  for (const id of ids) delete current[id]
  await db.put(STORE_META, current, key)
}

// Reviews index (global map of date -> reviewedAt). Kept around for
// backwards compatibility with code that may still read it during migration,
// but reviews now live on per-day journal docs as `reviewedAt`.
export async function getReviews() {
  const db = await getDB()
  return db.get(STORE_REVIEWS, 'index') || {}
}

export async function putReviews(reviews) {
  const db = await getDB()
  return db.put(STORE_REVIEWS, reviews, 'index')
}
