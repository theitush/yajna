/**
 * Sync service: bidirectional sync between IndexedDB and Google Drive.
 * Strategy: merge local + Drive on connect (newer updatedAt wins per id);
 * local writes push to Drive immediately when online.
 */
import {
  getTasks, putTasks, getNotes, putNotes, putJournal, getConfig, putConfig,
  putMeta, getAllTasksRaw, getAllNotesRaw, purgeTombstones,
  getReviews, putReviews,
} from './db'
import {
  getDriveFileIds, readJsonFile, writeJsonFile,
  findFile, writeJsonFile as driveWrite,
  getFileRevisions, getStoredRevisions, setStoredRevisions,
} from './drive'
import { mergeBlocks, htmlToBlocks, purgeOldBlockTombstones } from '../lib/blocks'

const BLOCK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

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
        const cutoff = new Date(Date.now() - BLOCK_TOMBSTONE_TTL_MS).toISOString()
        const merged = purgeOldBlockTombstones(mergeBlocks(loserBlocks, winnerBlocks), cutoff)
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
  const cutoff = new Date(Date.now() - BLOCK_TOMBSTONE_TTL_MS).toISOString()
  const merged = purgeOldBlockTombstones(mergeBlocks(localBlocks, remoteBlocks), cutoff)
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
  const t0 = performance.now()
  const mark = (label, from) => console.log(`[sync] ${label}: ${(performance.now() - from).toFixed(0)}ms`)

  const ids = await getDriveFileIds()
  if (!ids) return
  mark('getDriveFileIds', t0)

  // Phase: fetch current head revisions for all 4 files in parallel, compare
  // with what we last saw. Files whose revision is unchanged are skipped on
  // both read and write — local IDB is already in sync with Drive for them.
  const tRev = performance.now()
  const fileIds = [ids.tasksFileId, ids.notesFileId, ids.configFileId, ids.reviewsFileId]
  const [currentRevs, storedRevs] = await Promise.all([
    getFileRevisions(fileIds),
    getStoredRevisions(),
  ])
  mark('revision check', tRev)
  const unchanged = (id) => currentRevs[id] && storedRevs[id] === currentRevs[id]

  // Phase: read only the files whose revision changed. Unchanged remotes are
  // represented as null and skipped during merge (local is authoritative).
  const tRead = performance.now()
  const [remoteTasks, remoteNotes, remoteConfig, remoteReviews] = await Promise.all([
    unchanged(ids.tasksFileId) ? null : readJsonFile(ids.tasksFileId),
    unchanged(ids.notesFileId) ? null : readJsonFile(ids.notesFileId),
    unchanged(ids.configFileId) ? null : readJsonFile(ids.configFileId),
    unchanged(ids.reviewsFileId) ? null : readJsonFile(ids.reviewsFileId),
  ])
  const skipped = fileIds.filter(unchanged).length
  mark(`drive reads (${4 - skipped}/4 fetched, ${skipped} skipped)`, tRead)

  const tLocal = performance.now()
  // Use raw reads so tombstones participate in the merge.
  const [localTasks, localNotes, localConfig, localReviews] = await Promise.all([
    getAllTasksRaw(),
    getAllNotesRaw(),
    getConfig(),
    getReviews(),
  ])
  mark('local reads', tLocal)

  const tMerge = performance.now()
  const mergedTasks = remoteTasks == null
    ? localTasks
    : mergeById(localTasks, Array.isArray(remoteTasks) ? remoteTasks : [])
  const mergedNotes = remoteNotes == null
    ? localNotes
    : mergeById(localNotes, Array.isArray(remoteNotes) ? remoteNotes : [], { mergeBody: true })
  const mergedConfig = remoteConfig == null
    ? (localConfig || {})
    : { ...(localConfig || {}), ...(remoteConfig || {}) }
  const mergedReviews = remoteReviews == null
    ? (localReviews || {})
    : { ...(localReviews || {}), ...(remoteReviews || {}) }
  mark('merge', tMerge)

  // Decide which files actually need a writeback. If the merged result equals
  // what's on Drive, skip the upload entirely. Reference equality covers the
  // skipped-read case (merged === local && remote unchanged → Drive matches).
  const tDiff = performance.now()
  const tasksChanged = remoteTasks != null && !shallowEqualById(mergedTasks, remoteTasks)
  const notesChanged = remoteNotes != null && !shallowEqualById(mergedNotes, remoteNotes)
  const configChanged = remoteConfig != null && !shallowEqualObj(mergedConfig, remoteConfig)
  const reviewsChanged = remoteReviews != null && !shallowEqualObj(mergedReviews, remoteReviews)
  mark('diff', tDiff)

  // Local writeback only for buckets we actually re-merged.
  const tLocalWrite = performance.now()
  const localWrites = []
  if (remoteTasks != null) localWrites.push(putTasks(mergedTasks))
  if (remoteNotes != null) localWrites.push(putNotes(mergedNotes))
  if (remoteConfig != null) localWrites.push(putConfig(mergedConfig))
  if (remoteReviews != null) localWrites.push(putReviews(mergedReviews))
  await Promise.all(localWrites)
  mark('local writes', tLocalWrite)

  // Drive writeback only for buckets that actually differ from remote.
  const tDriveWrite = performance.now()
  const driveWrites = []
  if (tasksChanged) driveWrites.push(writeJsonFile(ids.rootId, 'tasks.json', mergedTasks, ids.tasksFileId))
  if (notesChanged) driveWrites.push(writeJsonFile(ids.rootId, 'notes.json', mergedNotes, ids.notesFileId))
  if (configChanged) driveWrites.push(writeJsonFile(ids.rootId, 'config.json', mergedConfig, ids.configFileId))
  if (reviewsChanged) driveWrites.push(writeJsonFile(ids.rootId, 'reviews.json', mergedReviews, ids.reviewsFileId))
  await Promise.all(driveWrites)
  mark(`drive writes (${driveWrites.length}/4)`, tDriveWrite)

  // After uploads, fetch fresh revs for the files we wrote so the next startup
  // can short-circuit. For unchanged files we keep the current rev we already saw.
  const newRevs = { ...storedRevs, ...currentRevs }
  if (driveWrites.length > 0) {
    const writtenIds = []
    if (tasksChanged) writtenIds.push(ids.tasksFileId)
    if (notesChanged) writtenIds.push(ids.notesFileId)
    if (configChanged) writtenIds.push(ids.configFileId)
    if (reviewsChanged) writtenIds.push(ids.reviewsFileId)
    const fresh = await getFileRevisions(writtenIds)
    Object.assign(newRevs, fresh)
  }

  // Background maintenance — don't block the spinner on these.
  setStoredRevisions(newRevs).catch(() => {})
  putMeta(LAST_SYNC_KEY, Date.now()).catch(() => {})
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  purgeTombstones(cutoff).catch(() => {})

  mark('TOTAL mergeWithDrive', t0)
  // Return the UI-facing view (no tombstones) so callers hydrate the store cleanly.
  return {
    mergedTasks: mergedTasks.filter(t => !t.deleted),
    mergedNotes: mergedNotes.filter(n => !n.deleted),
    mergedConfig,
    mergedReviews,
  }
}

/**
 * Cheap equality for id-keyed arrays: same length, same id+updatedAt set.
 * Good enough to detect "merge produced nothing new vs. remote" without a
 * full deep compare of every block.
 */
function shallowEqualById(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  const map = new Map()
  for (const it of b) map.set(it.id, it.updatedAt || it.createdAt || '')
  for (const it of a) {
    if (map.get(it.id) !== (it.updatedAt || it.createdAt || '')) return false
  }
  return true
}

function shallowEqualObj(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const ak = Object.keys(a), bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

/**
 * Pull a fresh copy from Drive (used for subsequent syncs, not first connect).
 * Does NOT merge — assumes Drive is authoritative after initial merge.
 */
export async function pullFromDrive() {
  const ids = await getDriveFileIds()
  if (!ids) return

  const [tasks, notes, config, reviews] = await Promise.all([
    readJsonFile(ids.tasksFileId),
    readJsonFile(ids.notesFileId),
    readJsonFile(ids.configFileId),
    readJsonFile(ids.reviewsFileId),
  ])

  await Promise.all([
    putTasks(Array.isArray(tasks) ? tasks : []),
    putNotes(Array.isArray(notes) ? notes : []),
    putConfig(config || {}),
    putReviews(reviews || {}),
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
 * Push reviews index to Drive. Merges with remote first.
 */
export async function pushReviews() {
  const ids = await getDriveFileIds()
  if (!ids) return null
  const local = await getReviews()
  const remote = await readJsonFile(ids.reviewsFileId)
  const merged = { ...(remote || {}), ...(local || {}) }
  await putReviews(merged)
  await writeJsonFile(ids.rootId, 'reviews.json', merged, ids.reviewsFileId)
  return merged
}

/**
 * Push a journal week doc to Drive. Merges with remote first so concurrent
 * edits from other devices aren't lost.
 */
export async function pushJournal(weekDoc) {
  const ids = await getDriveFileIds()
  if (!ids) return null
  const filename = `${weekDoc.week}.json`
  const existingId = await findFile(ids.journalsFolderId, filename)
  let merged = weekDoc
  if (existingId) {
    const remote = await readJsonFile(existingId)
    if (remote) merged = mergeJournalDocs(weekDoc, remote)
  }
  await putJournal(merged)
  await driveWrite(ids.journalsFolderId, filename, merged, existingId)
  return merged
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
