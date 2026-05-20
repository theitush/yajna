/**
 * Sync service: bidirectional sync between IndexedDB and Google Drive.
 * Strategy: merge local + Drive on connect (newer updatedAt wins per id);
 * local writes push to Drive immediately when online.
 */
import {
  putTasks, putNotes, putJournal, getConfig, putConfig,
  putMeta, getAllTasksRaw, getAllNotesRaw, purgeTombstones,
} from './db'
import {
  getDriveFileIds, readJsonFile, writeJsonFile,
  findFile, writeJsonFile as driveWrite,
  getFileRevisions, getStoredRevisions, setStoredRevisions,
} from './drive'
import { mergeBlocks, htmlToBlocks, purgeOldBlockTombstones } from '../lib/blocks'
import { dayKey } from '../lib/dates'

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
 * Merge two per-day journal docs. Blocks merge at the block level;
 * reviewedAt: newer wins. blockComments merge per blockId by updatedAt.
 */
export function mergeDayDoc(localDoc, remoteDoc) {
  if (!localDoc) return remoteDoc
  if (!remoteDoc) return localDoc
  const localBlocks = Array.isArray(localDoc.blocks) && localDoc.blocks.length
    ? localDoc.blocks
    : htmlToBlocks(localDoc.content || '')
  const remoteBlocks = Array.isArray(remoteDoc.blocks) && remoteDoc.blocks.length
    ? remoteDoc.blocks
    : htmlToBlocks(remoteDoc.content || '')
  const cutoff = new Date(Date.now() - BLOCK_TOMBSTONE_TTL_MS).toISOString()
  const blocks = purgeOldBlockTombstones(mergeBlocks(localBlocks, remoteBlocks), cutoff)

  const localUpd = toMs(localDoc.updatedAt)
  const remoteUpd = toMs(remoteDoc.updatedAt)
  const updatedAt = localUpd >= remoteUpd
    ? (localDoc.updatedAt || remoteDoc.updatedAt)
    : (remoteDoc.updatedAt || localDoc.updatedAt)

  // reviewedAt: newer wins
  const localRev = toMs(localDoc.reviewedAt)
  const remoteRev = toMs(remoteDoc.reviewedAt)
  let reviewedAt = null
  if (localRev || remoteRev) {
    reviewedAt = localRev >= remoteRev ? localDoc.reviewedAt : remoteDoc.reviewedAt
  }

  // blockComments: union of blockIds; per blockId, newer comment by updatedAt wins.
  const blockComments = { ...(remoteDoc.blockComments || {}) }
  for (const [bid, localList] of Object.entries(localDoc.blockComments || {})) {
    const remoteList = blockComments[bid]
    if (!remoteList) { blockComments[bid] = localList; continue }
    const local0 = Array.isArray(localList) ? localList[0] : null
    const remote0 = Array.isArray(remoteList) ? remoteList[0] : null
    if (!local0) continue
    if (!remote0) { blockComments[bid] = localList; continue }
    const lt = toMs(local0.updatedAt || local0.createdAt)
    const rt = toMs(remote0.updatedAt || remote0.createdAt)
    blockComments[bid] = lt >= rt ? localList : remoteList
  }

  const createdAt = localDoc.createdAt && remoteDoc.createdAt
    ? (localDoc.createdAt <= remoteDoc.createdAt ? localDoc.createdAt : remoteDoc.createdAt)
    : (localDoc.createdAt || remoteDoc.createdAt)

  return {
    date: localDoc.date || remoteDoc.date,
    blocks,
    reviewedAt: reviewedAt || null,
    blockComments,
    createdAt: createdAt || updatedAt,
    updatedAt,
  }
}

function toMs(iso) {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return isFinite(t) ? t : 0
}

/**
 * Merge Drive data with local IndexedDB data, write result back to both.
 *
 * Returns per-bucket promises so callers can await only the buckets they
 * need before showing UI, and let the rest finish in the background.
 *
 *   const handle = mergeWithDriveStreaming()
 *   await handle.buckets.tasks   // resolves to merged tasks (UI-ready)
 *   await handle.done            // all buckets merged + drive writeback done
 *
 * Each bucket promise resolves once that bucket's local IDB write is done
 * (so the store can be hydrated). Drive writebacks happen as a tail step
 * gated by `done`.
 */
export function mergeWithDriveStreaming() {
  const buckets = { tasks: null, notes: null, config: null }
  let resolveTasks, resolveNotes, resolveConfig
  buckets.tasks = new Promise(r => { resolveTasks = r })
  buckets.notes = new Promise(r => { resolveNotes = r })
  buckets.config = new Promise(r => { resolveConfig = r })
  const resolvers = { tasks: resolveTasks, notes: resolveNotes, config: resolveConfig }

  const done = (async () => {
    const out = await mergeWithDriveImpl(resolvers)
    return out
  })()

  // Swallow rejections on bucket promises if the overall sync fails — the
  // caller is awaiting `done` for error propagation.
  for (const k of Object.keys(buckets)) buckets[k].catch(() => {})

  return { buckets, done }
}

/**
 * Convenience: run the full streaming merge and await everything.
 */
export async function mergeWithDrive() {
  return mergeWithDriveStreaming().done
}

async function mergeWithDriveImpl(resolvers) {
  const t0 = performance.now()
  const mark = (label, from) => console.log(`[sync] ${label}: ${(performance.now() - from).toFixed(0)}ms`)

  const ids = await getDriveFileIds()
  if (!ids) {
    for (const r of Object.values(resolvers)) r(null)
    return
  }
  mark('getDriveFileIds', t0)

  const tRev = performance.now()
  const fileIds = [ids.tasksFileId, ids.notesFileId, ids.configFileId]
  const [currentRevs, storedRevs] = await Promise.all([
    getFileRevisions(fileIds),
    getStoredRevisions(),
  ])
  mark('revision check', tRev)
  const unchanged = (id) => currentRevs[id] && storedRevs[id] === currentRevs[id]

  const driveWrites = []
  const writtenIds = []

  async function mergeBucket({
    bucketKey, fileId, fileName,
    readLocal, mergeFn, writeLocal,
  }) {
    const tReadLocal = performance.now()
    const localData = await readLocal()
    mark(`local read (${bucketKey})`, tReadLocal)

    const tReadRemote = performance.now()
    const remoteData = unchanged(fileId) ? null : await readJsonFile(fileId)
    mark(`drive read (${bucketKey}${unchanged(fileId) ? ' skipped' : ''})`, tReadRemote)

    const merged = mergeFn(localData, remoteData)
    const remoteSkipped = remoteData == null
    const equal = remoteSkipped ? true : mergeFn.equal(merged, remoteData)

    if (!remoteSkipped) await writeLocal(merged)

    if (!equal) {
      driveWrites.push(writeJsonFile(ids.rootId, fileName, merged, fileId))
      writtenIds.push(fileId)
    }
    return merged
  }

  const tasksP = mergeBucket({
    bucketKey: 'tasks',
    fileId: ids.tasksFileId,
    fileName: 'tasks.json',
    readLocal: getAllTasksRaw,
    mergeFn: Object.assign(
      (local, remote) => remote == null ? local : mergeById(local, Array.isArray(remote) ? remote : []),
      { equal: shallowEqualById },
    ),
    writeLocal: putTasks,
  }).then(merged => {
    resolvers.tasks(merged.filter(t => !t.deleted))
    return merged
  }, err => { resolvers.tasks(null); throw err })

  const notesP = mergeBucket({
    bucketKey: 'notes',
    fileId: ids.notesFileId,
    fileName: 'notes.json',
    readLocal: getAllNotesRaw,
    mergeFn: Object.assign(
      (local, remote) => remote == null ? local : mergeById(local, Array.isArray(remote) ? remote : [], { mergeBody: true }),
      { equal: shallowEqualById },
    ),
    writeLocal: putNotes,
  }).then(merged => {
    resolvers.notes(merged.filter(n => !n.deleted))
    return merged
  }, err => { resolvers.notes(null); throw err })

  const configP = mergeBucket({
    bucketKey: 'config',
    fileId: ids.configFileId,
    fileName: 'config.json',
    readLocal: getConfig,
    mergeFn: Object.assign(
      (local, remote) => remote == null ? (local || {}) : { ...(local || {}), ...(remote || {}) },
      { equal: shallowEqualObj },
    ),
    writeLocal: putConfig,
  }).then(merged => {
    resolvers.config(merged)
    return merged
  }, err => { resolvers.config(null); throw err })

  const [mergedTasks, mergedNotes, mergedConfig] = await Promise.all([tasksP, notesP, configP])

  const tDriveWrite = performance.now()
  await Promise.all(driveWrites)
  mark(`drive writes (${driveWrites.length}/3)`, tDriveWrite)

  const newRevs = { ...storedRevs, ...currentRevs }
  if (writtenIds.length > 0) {
    const fresh = await getFileRevisions(writtenIds)
    Object.assign(newRevs, fresh)
  }

  setStoredRevisions(newRevs).catch(() => {})
  putMeta(LAST_SYNC_KEY, Date.now()).catch(() => {})
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  purgeTombstones(cutoff).catch(() => {})

  mark('TOTAL mergeWithDrive', t0)
  return {
    mergedTasks: mergedTasks.filter(t => !t.deleted),
    mergedNotes: mergedNotes.filter(n => !n.deleted),
    mergedConfig,
  }
}

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
 * Push a per-day journal doc to Drive. Merges with remote first so concurrent
 * edits from other devices aren't lost.
 */
export async function pushJournal(dayDoc) {
  const ids = await getDriveFileIds()
  if (!ids || !dayDoc?.date) return null
  const date = dayKey(dayDoc.date)
  const filename = `${date}.json`
  const existingId = await findFile(ids.journalsFolderId, filename)
  let merged = dayDoc
  if (existingId) {
    const remote = await readJsonFile(existingId)
    if (remote) merged = mergeDayDoc(dayDoc, remote)
  }
  await putJournal(merged)
  await driveWrite(ids.journalsFolderId, filename, merged, existingId)
  return merged
}

/**
 * Pull a single day's journal from Drive into IndexedDB.
 */
export async function pullJournal(date) {
  const ids = await getDriveFileIds()
  if (!ids) return null
  const filename = `${dayKey(date)}.json`
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
 * Streaming initial sync.
 */
export function initialSyncStreaming() {
  return mergeWithDriveStreaming()
}

/**
 * Merge a single day's journal doc with Drive and push merged result.
 * Uses headRevisionId to skip the read when remote is unchanged since last
 * seen, and skips the upload when the merged doc equals what's on Drive.
 */
export async function mergeAndPushJournal(dayDoc) {
  const t0 = performance.now()
  const mark = (label, from) => console.log(`[journal-sync] ${label}: ${(performance.now() - from).toFixed(0)}ms`)

  const ids = await getDriveFileIds()
  if (!ids || !dayDoc?.date) return dayDoc
  const date = dayKey(dayDoc.date)
  const filename = `${date}.json`

  const tFind = performance.now()
  const existingId = await findFile(ids.journalsFolderId, filename)
  mark('findFile', tFind)

  if (!existingId) {
    await driveWrite(ids.journalsFolderId, filename, dayDoc, null)
    mark('TOTAL (new file)', t0)
    return dayDoc
  }

  const tRev = performance.now()
  const [revs, storedRevs] = await Promise.all([
    getFileRevisions([existingId]),
    getStoredRevisions(),
  ])
  mark('rev check', tRev)
  const currentRev = revs[existingId]
  const lastSeen = storedRevs[existingId]
  const remoteUnchanged = currentRev && lastSeen === currentRev

  let merged = dayDoc
  let remote = null
  if (!remoteUnchanged) {
    const tRead = performance.now()
    remote = await readJsonFile(existingId)
    mark('readJsonFile', tRead)
    if (remote) merged = mergeDayDoc(dayDoc, remote)
  }

  const needsWrite = remote
    ? !dayDocsEqual(merged, remote)
    : !remoteUnchanged

  if (needsWrite) {
    const tWrite = performance.now()
    await driveWrite(ids.journalsFolderId, filename, merged, existingId)
    mark('driveWrite', tWrite)
    const fresh = await getFileRevisions([existingId])
    setStoredRevisions({ ...storedRevs, ...fresh }).catch(() => {})
  } else if (currentRev && lastSeen !== currentRev) {
    setStoredRevisions({ ...storedRevs, [existingId]: currentRev }).catch(() => {})
  }

  await putJournal(merged)
  mark('TOTAL mergeAndPushJournal', t0)
  return merged
}

/**
 * Cheap equality for per-day journal docs.
 */
function dayDocsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.date !== b.date) return false
  if ((a.updatedAt || '') !== (b.updatedAt || '')) return false
  if ((a.reviewedAt || '') !== (b.reviewedAt || '')) return false
  return true
}
