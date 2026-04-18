import { openDB } from 'idb'
import {
  DB_NAME, DB_VERSION,
  STORE_TASKS, STORE_NOTES, STORE_JOURNALS, STORE_CONFIG, STORE_META, STORE_AUDIO,
} from '../lib/constants'

let dbPromise = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_TASKS)) {
          db.createObjectStore(STORE_TASKS, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          db.createObjectStore(STORE_NOTES, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORE_JOURNALS)) {
          // key is the week string e.g. "2026-W15"
          db.createObjectStore(STORE_JOURNALS, { keyPath: 'week' })
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
      },
    })
  }
  return dbPromise
}

// Tasks
// Reads filter out tombstones so the UI never sees soft-deleted rows.
// Tombstones still live in IDB/Drive so multi-device sync knows about the delete.
export async function getTasks() {
  const db = await getDB()
  const all = await db.getAll(STORE_TASKS)
  return all.filter(t => !t.deleted)
}

export async function getAllTasksRaw() {
  const db = await getDB()
  return db.getAll(STORE_TASKS)
}

export async function putTask(task) {
  const db = await getDB()
  return db.put(STORE_TASKS, task)
}

export async function putTasks(tasks) {
  const db = await getDB()
  const tx = db.transaction(STORE_TASKS, 'readwrite')
  await Promise.all([...tasks.map(t => tx.store.put(t)), tx.done])
}

// Soft-delete: writes a tombstone (deleted: true + deletedAt) so the delete
// propagates via sync. Pass a minimal object to avoid keeping stale content.
export async function deleteTask(id) {
  const db = await getDB()
  const now = new Date().toISOString()
  return db.put(STORE_TASKS, { id, deleted: true, deletedAt: now, updatedAt: now })
}

// Notes
export async function getNotes() {
  const db = await getDB()
  const all = await db.getAll(STORE_NOTES)
  return all.filter(n => !n.deleted)
}

export async function getAllNotesRaw() {
  const db = await getDB()
  return db.getAll(STORE_NOTES)
}

export async function putNote(note) {
  const db = await getDB()
  return db.put(STORE_NOTES, note)
}

export async function putNotes(notes) {
  const db = await getDB()
  const tx = db.transaction(STORE_NOTES, 'readwrite')
  await Promise.all([...notes.map(n => tx.store.put(n)), tx.done])
}

export async function deleteNote(id) {
  const db = await getDB()
  const now = new Date().toISOString()
  return db.put(STORE_NOTES, { id, deleted: true, deletedAt: now, updatedAt: now })
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

// Journals
export async function getJournal(week) {
  const db = await getDB()
  return db.get(STORE_JOURNALS, week)
}

export async function putJournal(journalDoc) {
  const db = await getDB()
  return db.put(STORE_JOURNALS, journalDoc)
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
export async function putAudio(record) {
  const db = await getDB()
  return db.put(STORE_AUDIO, record)
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
