/**
 * Sync service: bidirectional sync between IndexedDB and Google Drive.
 * Strategy: Drive is source of truth on load; local writes queue and flush when online.
 */
import {
  getTasks, putTasks, getNotes, putNotes, getJournal, putJournal, getConfig, putConfig,
  getMeta, putMeta,
} from './db'
import {
  getDriveFileIds, initDriveStructure, readJsonFile, writeJsonFile,
  findFile, writeJsonFile as driveWrite,
} from './drive'

const PENDING_KEY = 'pending_sync'
const LAST_SYNC_KEY = 'last_sync'

/**
 * Pull all data from Drive into IndexedDB
 */
export async function pullFromDrive() {
  const ids = await getDriveFileIds()
  if (!ids) return

  const [tasks, notes, config] = await Promise.all([
    readJsonFile(ids.tasksFileId),
    readJsonFile(ids.notesFileId),
    readJsonFile(ids.configFileId),
  ])

  await Promise.all([
    putTasks(Array.isArray(tasks) ? tasks : []),
    putNotes(Array.isArray(notes) ? notes : []),
    putConfig(config || {}),
  ])

  await putMeta(LAST_SYNC_KEY, Date.now())
}

/**
 * Push tasks to Drive
 */
export async function pushTasks() {
  const ids = await getDriveFileIds()
  if (!ids) return
  const tasks = await getTasks()
  await writeJsonFile(ids.rootId, 'tasks.json', tasks, ids.tasksFileId)
}

/**
 * Push notes to Drive
 */
export async function pushNotes() {
  const ids = await getDriveFileIds()
  if (!ids) return
  const notes = await getNotes()
  await writeJsonFile(ids.rootId, 'notes.json', notes, ids.notesFileId)
}

/**
 * Push config to Drive
 */
export async function pushConfig() {
  const ids = await getDriveFileIds()
  if (!ids) return
  const config = await getConfig()
  await writeJsonFile(ids.rootId, 'config.json', config, ids.configFileId)
}

/**
 * Push a journal week doc to Drive
 */
export async function pushJournal(weekDoc) {
  const ids = await getDriveFileIds()
  if (!ids) return
  const filename = `${weekDoc.week}.json`
  const existingId = await findFile(ids.journalsFolderId, filename)
  await driveWrite(ids.journalsFolderId, filename, weekDoc, existingId)
}

/**
 * Pull a single journal week from Drive into IndexedDB
 */
export async function pullJournal(week) {
  const ids = await getDriveFileIds()
  if (!ids) return null
  const filename = `${week}.json`
  const fileId = await findFile(ids.journalsFolderId, filename)
  if (!fileId) return null
  const doc = await readJsonFile(fileId)
  if (doc) await putJournal(doc)
  return doc
}

/**
 * Full initial sync: pull everything from Drive
 */
export async function initialSync() {
  await pullFromDrive()
}
