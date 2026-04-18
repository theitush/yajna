/**
 * Sync service: bidirectional sync between IndexedDB and Google Drive.
 * Strategy: merge local + Drive on connect (newer updatedAt wins per id);
 * local writes push to Drive immediately when online.
 */
import {
  getTasks, putTasks, getNotes, putNotes, putJournal, getConfig, putConfig,
  putMeta, getAllTasksRaw, getAllNotesRaw, purgeTombstones,
} from './db'
import {
  getDriveFileIds, readJsonFile, writeJsonFile,
  findFile, writeJsonFile as driveWrite,
} from './drive'
import { mergeBlocks, htmlToBlocks } from '../lib/blocks'

const LAST_SYNC_KEY = 'last_sync'

/**
 * Merge two arrays by id. For items present on both sides, newer updatedAt wins.
 * Items only on one side are always kept.
 */
function mergeById(local, remote, opts = {}) {
  const map = new Map()
  for (const item of local) map.set(item.id, item)
  for (const item of remote) {
    const existing = map.get(item.id)
    if (!existing) {
      map.set(item.id, item)
    } else {
      const localTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime()
      const remoteTime = new Date(item.updatedAt || item.createdAt || 0).getTime()
      const winner = remoteTime > localTime ? item : existing
      const loser = winner === item ? existing : item
      if (opts.mergeBody && !winner.deleted && !loser.deleted) {
        // Safe body merge: merge blocks so concurrent edits on different
        // paragraphs both survive. Nothing gets silently dropped.
        const winnerBlocks = Array.isArray(winner.blocks) && winner.blocks.length ? winner.blocks : htmlToBlocks(winner.body || '')
        const loserBlocks = Array.isArray(loser.blocks) && loser.blocks.length ? loser.blocks : htmlToBlocks(loser.body || '')
        const merged = mergeBlocks(loserBlocks, winnerBlocks)
        const mergedNote = { ...winner, blocks: merged }
        delete mergedNote.body
        map.set(item.id, mergedNote)
      } else {
        map.set(item.id, winner)
      }
    }
  }
  return Array.from(map.values())
}

/**
 * Merge two journal week docs. Per date entry, newer updatedAt wins.
 */
function mergeJournalDocs(local, remote) {
  const entries = { ...(local?.entries || {}) }
  for (const [date, remoteEntry] of Object.entries(remote?.entries || {})) {
    const localEntry = entries[date]
    if (!localEntry) {
      entries[date] = remoteEntry
      continue
    }
    entries[date] = mergeJournalEntry(localEntry, remoteEntry)
  }
  return { ...(remote || {}), ...(local || {}), entries, week: (local?.week || remote?.week) }
}

/**
 * Merge two journal entries at the block level. Concurrent edits on
 * different paragraphs both survive; same-paragraph conflicts keep both
 * (loser is appended as a conflict-marked block).
 */
export function mergeJournalEntry(localEntry, remoteEntry) {
  if (!localEntry) return remoteEntry
  if (!remoteEntry) return localEntry
  const localBlocks = Array.isArray(localEntry.blocks) && localEntry.blocks.length
    ? localEntry.blocks
    : htmlToBlocks(localEntry.content || '')
  const remoteBlocks = Array.isArray(remoteEntry.blocks) && remoteEntry.blocks.length
    ? remoteEntry.blocks
    : htmlToBlocks(remoteEntry.content || '')
  const merged = mergeBlocks(localBlocks, remoteBlocks)
  const newerStamp = (toMs(localEntry.updatedAt) >= toMs(remoteEntry.updatedAt))
    ? (localEntry.updatedAt || remoteEntry.updatedAt)
    : (remoteEntry.updatedAt || localEntry.updatedAt)
  const out = {
    ...remoteEntry,
    ...localEntry,
    blocks: merged,
    updatedAt: newerStamp,
    createdAt: localEntry.createdAt || remoteEntry.createdAt,
  }
  delete out.content
  return out
}

function toMs(iso) {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return isFinite(t) ? t : 0
}

/**
 * Merge Drive data with local IndexedDB data, write result back to both.
 */
export async function mergeWithDrive() {
  const ids = await getDriveFileIds()
  if (!ids) return

  const [remoteTasks, remoteNotes, remoteConfig] = await Promise.all([
    readJsonFile(ids.tasksFileId),
    readJsonFile(ids.notesFileId),
    readJsonFile(ids.configFileId),
  ])

  // Use raw reads so tombstones participate in the merge.
  const [localTasks, localNotes, localConfig] = await Promise.all([
    getAllTasksRaw(),
    getAllNotesRaw(),
    getConfig(),
  ])

  const mergedTasks = mergeById(localTasks, Array.isArray(remoteTasks) ? remoteTasks : [])
  const mergedNotes = mergeById(localNotes, Array.isArray(remoteNotes) ? remoteNotes : [], { mergeBody: true })
  const mergedConfig = { ...(localConfig || {}), ...(remoteConfig || {}) }

  // Write merged data (including tombstones) back to local and Drive
  await Promise.all([
    putTasks(mergedTasks),
    putNotes(mergedNotes),
    putConfig(mergedConfig),
  ])
  await Promise.all([
    writeJsonFile(ids.rootId, 'tasks.json', mergedTasks, ids.tasksFileId),
    writeJsonFile(ids.rootId, 'notes.json', mergedNotes, ids.notesFileId),
    writeJsonFile(ids.rootId, 'config.json', mergedConfig, ids.configFileId),
  ])

  // Purge tombstones older than 30 days so storage doesn't grow unbounded.
  // By this point all devices have had plenty of time to see the delete.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  await purgeTombstones(cutoff).catch(() => {})

  await putMeta(LAST_SYNC_KEY, Date.now())
  // Return the UI-facing view (no tombstones) so callers hydrate the store cleanly.
  return {
    mergedTasks: mergedTasks.filter(t => !t.deleted),
    mergedNotes: mergedNotes.filter(n => !n.deleted),
    mergedConfig,
  }
}

/**
 * Pull a fresh copy from Drive (used for subsequent syncs, not first connect).
 * Does NOT merge — assumes Drive is authoritative after initial merge.
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
 * Push tasks to Drive. Merges with remote first so a concurrent edit from
 * another device isn't clobbered — per-id, newer updatedAt wins.
 * Returns the merged array so callers can reconcile their local state.
 */
export async function pushTasks() {
  const ids = await getDriveFileIds()
  if (!ids) return null
  const localTasks = await getAllTasksRaw()
  const remoteTasks = await readJsonFile(ids.tasksFileId)
  const merged = mergeById(localTasks, Array.isArray(remoteTasks) ? remoteTasks : [])
  await putTasks(merged)
  await writeJsonFile(ids.rootId, 'tasks.json', merged, ids.tasksFileId)
  return merged
}

/**
 * Push notes to Drive. Merges with remote first (see pushTasks).
 */
export async function pushNotes() {
  const ids = await getDriveFileIds()
  if (!ids) return null
  const localNotes = await getAllNotesRaw()
  const remoteNotes = await readJsonFile(ids.notesFileId)
  const merged = mergeById(localNotes, Array.isArray(remoteNotes) ? remoteNotes : [], { mergeBody: true })
  await putNotes(merged)
  await writeJsonFile(ids.rootId, 'notes.json', merged, ids.notesFileId)
  return merged
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
 * Initial sync on connect: merge local data with Drive, then push merged result.
 */
export async function initialSync() {
  return mergeWithDrive()
}

/**
 * Merge a single journal week doc with Drive and push merged result.
 */
export async function mergeAndPushJournal(weekDoc) {
  const ids = await getDriveFileIds()
  if (!ids) return weekDoc
  const filename = `${weekDoc.week}.json`
  const existingId = await findFile(ids.journalsFolderId, filename)
  let merged = weekDoc
  if (existingId) {
    const remote = await readJsonFile(existingId)
    if (remote) merged = mergeJournalDocs(weekDoc, remote)
  }
  await driveWrite(ids.journalsFolderId, filename, merged, existingId)
  return merged
}
