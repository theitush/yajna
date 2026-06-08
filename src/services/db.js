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
  // Single readwrite tx so the get+put is atomic: a concurrent putTask (the
  // row owner) can't slip between our read and write and get its fresh fields
  // clobbered. We only ever touch `_doc`, never the materialized row fields.
  const tx = db.transaction(STORE_TASKS, 'readwrite')
  const existing = await tx.store.get(id)
  await tx.store.put({ ...(existing || { id }), _doc: bytes })
  await tx.done
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

// Single-note fresh read (mirrors getTask). Used by pushNotes to re-read the
// row right before serializing, so a second edit landing mid-push isn't lost.
export async function getNoteRaw(id) {
  const db = await getDB()
  return stripDoc(await db.get(STORE_NOTES, id))
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
// Phase C: rows also carry `_doc: Uint8Array` (Automerge bytes) inline. Reads
// strip it so UI/store don't see it.
export async function getJournal(date) {
  const db = await getDB()
  return stripDoc(await db.get(STORE_JOURNALS, date))
}

export async function putJournal(dayDoc, opts) {
  if (!dayDoc?.date) return
  const db = await getDB()
  // Preserve any `_doc` bytes already on the row — UI write paths read journals
  // via stripDoc and pass back rows without `_doc`. Mirrors putTask/putNote.
  let next = dayDoc
  if (!(dayDoc._doc instanceof Uint8Array)) {
    const existing = await db.get(STORE_JOURNALS, dayDoc.date)
    if (existing?._doc instanceof Uint8Array) next = { ...dayDoc, _doc: existing._doc }
  }
  await db.put(STORE_JOURNALS, next)
  if (!opts?.fromSync) await markDirty('journal', dayDoc.date)
}

export async function getAllJournals() {
  const db = await getDB()
  const all = await db.getAll(STORE_JOURNALS)
  return all.map(stripDoc)
}

export async function getJournalDocBytes(date) {
  const db = await getDB()
  const row = await db.get(STORE_JOURNALS, date)
  return row?._doc instanceof Uint8Array ? row._doc : null
}

export async function putJournalDocBytes(date, bytes) {
  if (!date || !(bytes instanceof Uint8Array)) return
  const db = await getDB()
  const existing = await db.get(STORE_JOURNALS, date)
  await db.put(STORE_JOURNALS, { ...(existing || { date }), _doc: bytes })
}

export async function putJournalWithDoc(dayDoc, bytes, opts) {
  if (!dayDoc?.date) return
  const db = await getDB()
  const next = bytes instanceof Uint8Array ? { ...dayDoc, _doc: bytes } : dayDoc
  await db.put(STORE_JOURNALS, next)
  if (!opts?.fromSync) await markDirty('journal', dayDoc.date)
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

// Config Automerge doc bytes. The config store is keyed out-of-line (single
// 'config' record), so the doc bytes ride in meta rather than on the row like
// tasks/notes do. `config` is a singleton entity — its dirty id is 'config'.
export async function getConfigDocBytes() {
  const db = await getDB()
  const bytes = await db.get(STORE_META, 'config_doc')
  return bytes instanceof Uint8Array ? bytes : null
}

export async function putConfigWithDoc(config, bytes, opts) {
  const db = await getDB()
  await db.put(STORE_CONFIG, config, 'config')
  if (bytes instanceof Uint8Array) await db.put(STORE_META, bytes, 'config_doc')
  if (!opts?.fromSync) await markDirty('config', 'config')
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
 * batch. Keyed in meta as `dirty_<type>` → { [id]: token }.
 *
 * The VALUE is a strictly-increasing dirty TOKEN, not a bare `true`. This is
 * load-bearing: a push is fire-and-forget from updateTask, so a SECOND edit to
 * the same id can land WHILE a push is mid-flight (mark-done, then type
 * feedback ~1s later — proven from device logs). With a boolean flag the second
 * markDirty is a no-op (flag already set), and the first push's clearDirty wipes
 * the flag the second edit was relying on — so the coalesced follow-up push
 * finds nothing dirty and the second edit NEVER reaches Drive (the "stale
 * feedback on the other device" data loss). With a token, the second markDirty
 * bumps the value; the push captures the token it actually shipped and
 * clearDirty only removes the id when the stored token still equals it. A newer
 * edit's token survives → the coalesced push re-ships it.
 */
let dirtyTokenSeq = 0
function nextDirtyToken() {
  // Process-monotonic + wall-clock so it's strictly increasing within a session
  // and doesn't collide on sub-ms double-writes (Date.now() alone can repeat).
  dirtyTokenSeq += 1
  return Date.now() * 1000 + (dirtyTokenSeq % 1000)
}

export async function markDirty(type, id) {
  if (!id) return
  const db = await getDB()
  const key = `dirty_${type}`
  const current = (await db.get(STORE_META, key)) || {}
  // Always bump the token, even if already dirty: a second edit mid-push must
  // produce a NEWER token than the one the in-flight push captured, so its
  // clearDirty can't claim this edit was already shipped.
  current[id] = nextDirtyToken()
  await db.put(STORE_META, current, key)
}

export async function getDirty(type) {
  const db = await getDB()
  return (await db.get(STORE_META, `dirty_${type}`)) || {}
}

/**
 * Clear dirty entries after a successful push. `pushed` is either:
 *  - an array of ids → unconditional clear (singletons / callers that don't
 *    track per-id tokens), or
 *  - a { id: token } map → compare-and-clear: only remove an id when its stored
 *    token STILL equals the token captured at push time. If a concurrent edit
 *    bumped the token mid-push, the entry survives so the next push re-ships it.
 */
export async function clearDirty(type, pushed) {
  const isMap = pushed && !Array.isArray(pushed)
  const ids = isMap ? Object.keys(pushed) : pushed
  if (!ids?.length) return
  const db = await getDB()
  const key = `dirty_${type}`
  const current = (await db.get(STORE_META, key)) || {}
  for (const id of ids) {
    if (isMap && current[id] !== pushed[id]) continue // re-dirtied mid-push — keep
    delete current[id]
  }
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
