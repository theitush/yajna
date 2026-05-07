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
  const buckets = { tasks: null, notes: null, config: null, reviews: null }
  let resolveTasks, resolveNotes, resolveConfig, resolveReviews
  buckets.tasks = new Promise(r => { resolveTasks = r })
  buckets.notes = new Promise(r => { resolveNotes = r })
  buckets.config = new Promise(r => { resolveConfig = r })
  buckets.reviews = new Promise(r => { resolveReviews = r })
  const resolvers = { tasks: resolveTasks, notes: resolveNotes, config: resolveConfig, reviews: resolveReviews }

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
 * Convenience: run the full streaming merge and await everything. Behaves
 * like the previous mergeWithDrive(): resolves only when all buckets and
 * Drive writebacks are done.
 */
export async function mergeWithDrive() {
  return mergeWithDriveStreaming().done
}

async function mergeWithDriveImpl(resolvers) {
  const t0 = performance.now()
  const mark = (label, from) => console.log(`[sync] ${label}: ${(performance.now() - from).toFixed(0)}ms`)

  const ids = await getDriveFileIds()
  if (!ids) {
    // No Drive — resolve all buckets with null so callers don't hang.
    for (const r of Object.values(resolvers)) r(null)
    return
  }
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

  // Per-bucket pipelines: each runs read → merge → local write independently
  // and resolves its bucket promise as soon as the local write lands. Drive
  // writeback is collected and awaited after all buckets are locally hydrated
  // (fine to run in the background while the UI is already interactive).

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

  // Kick off all four pipelines in parallel. Each resolves its bucket promise
  // independently so the UI can hydrate piecemeal.
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

  const reviewsP = mergeBucket({
    bucketKey: 'reviews',
    fileId: ids.reviewsFileId,
    fileName: 'reviews.json',
    readLocal: getReviews,
    mergeFn: Object.assign(
      (local, remote) => remote == null ? (local || {}) : { ...(local || {}), ...(remote || {}) },
      { equal: shallowEqualObj },
    ),
    writeLocal: putReviews,
  }).then(merged => {
    resolvers.reviews(merged)
    return merged
  }, err => { resolvers.reviews(null); throw err })

  const [mergedTasks, mergedNotes, mergedConfig, mergedReviews] = await Promise.all([tasksP, notesP, configP, reviewsP])

  // Drive writebacks: now that all merges are settled, push any buckets that
  // diverged from remote.
  const tDriveWrite = performance.now()
  await Promise.all(driveWrites)
  mark(`drive writes (${driveWrites.length}/4)`, tDriveWrite)

  // After uploads, fetch fresh revs for the files we wrote so the next startup
  // can short-circuit. For unchanged files we keep the current rev we already saw.
  const newRevs = { ...storedRevs, ...currentRevs }
  if (writtenIds.length > 0) {
    const fresh = await getFileRevisions(writtenIds)
    Object.assign(newRevs, fresh)
  }

  // Background maintenance — don't block on these.
  setStoredRevisions(newRevs).catch(() => {})
  putMeta(LAST_SYNC_KEY, Date.now()).catch(() => {})
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  purgeTombstones(cutoff).catch(() => {})

  mark('TOTAL mergeWithDrive', t0)
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
 * Streaming initial sync: returns per-bucket promises plus a `done` promise
 * for the full merge + Drive writeback. Callers can await only the buckets
 * they need to render the active screen, then continue in the background.
 */
export function initialSyncStreaming() {
  return mergeWithDriveStreaming()
}

/**
 * Merge a single journal week doc with Drive and push merged result.
 * Uses headRevisionId to skip the read when remote is unchanged since last
 * seen, and skips the upload when the merged doc equals what's on Drive.
 */
export async function mergeAndPushJournal(weekDoc) {
  const t0 = performance.now()
  const mark = (label, from) => console.log(`[journal-sync] ${label}: ${(performance.now() - from).toFixed(0)}ms`)

  const ids = await getDriveFileIds()
  if (!ids) return weekDoc
  const filename = `${weekDoc.week}.json`

  const tFind = performance.now()
  const existingId = await findFile(ids.journalsFolderId, filename)
  mark('findFile', tFind)

  if (!existingId) {
    // No remote yet — just upload the local doc.
    await driveWrite(ids.journalsFolderId, filename, weekDoc, null)
    mark('TOTAL (new file)', t0)
    return weekDoc
  }

  // Check headRevisionId before reading. If unchanged since last seen, skip
  // the read entirely — local IDB already reflects what's on Drive.
  const tRev = performance.now()
  const [revs, storedRevs] = await Promise.all([
    getFileRevisions([existingId]),
    getStoredRevisions(),
  ])
  mark('rev check', tRev)
  const currentRev = revs[existingId]
  const lastSeen = storedRevs[existingId]
  const remoteUnchanged = currentRev && lastSeen === currentRev

  let merged = weekDoc
  let remote = null
  if (!remoteUnchanged) {
    const tRead = performance.now()
    remote = await readJsonFile(existingId)
    mark('readJsonFile', tRead)
    if (remote) merged = mergeJournalDocs(weekDoc, remote)
  }

  // Skip upload if merged equals remote (covers no-op startup) or if remote
  // unchanged AND local hasn't diverged (covered by remote==null && merged===weekDoc).
  const needsWrite = remote
    ? !journalDocsEqual(merged, remote)
    : !remoteUnchanged // unchanged remote we didn't read → no need to write
      ? true
      : false

  if (needsWrite) {
    const tWrite = performance.now()
    await driveWrite(ids.journalsFolderId, filename, merged, existingId)
    mark('driveWrite', tWrite)
    // Refresh stored rev so the next call can short-circuit.
    const fresh = await getFileRevisions([existingId])
    setStoredRevisions({ ...storedRevs, ...fresh }).catch(() => {})
  } else if (currentRev && lastSeen !== currentRev) {
    // We saw a new rev and read it but merge produced no change — still update
    // our last-seen marker so next boot can skip the read.
    setStoredRevisions({ ...storedRevs, [existingId]: currentRev }).catch(() => {})
  }

  mark('TOTAL mergeAndPushJournal', t0)
  return merged
}

/**
 * Cheap equality for journal docs at the per-date entry level.
 * Same dates and same updatedAt per entry → no meaningful diff.
 */
function journalDocsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.week !== b.week) return false
  const ae = a.entries || {}, be = b.entries || {}
  const ak = Object.keys(ae), bk = Object.keys(be)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!(k in be)) return false
    if ((ae[k]?.updatedAt || '') !== (be[k]?.updatedAt || '')) return false
  }
  return true
}
