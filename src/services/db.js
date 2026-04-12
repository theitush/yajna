import { openDB } from 'idb'
import {
  DB_NAME, DB_VERSION,
  STORE_TASKS, STORE_NOTES, STORE_JOURNALS, STORE_CONFIG, STORE_META,
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
      },
    })
  }
  return dbPromise
}

// Tasks
export async function getTasks() {
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

export async function deleteTask(id) {
  const db = await getDB()
  return db.delete(STORE_TASKS, id)
}

// Notes
export async function getNotes() {
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
  return db.delete(STORE_NOTES, id)
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

// Config
export async function getConfig() {
  const db = await getDB()
  return db.get(STORE_CONFIG, 'config') || {}
}

export async function putConfig(config) {
  const db = await getDB()
  return db.put(STORE_CONFIG, config, 'config')
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
