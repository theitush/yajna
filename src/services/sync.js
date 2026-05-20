/**
 * Sync service: bidirectional sync between IndexedDB and Google Drive.
 * Strategy: merge local + Drive on connect (newer updatedAt wins per id);
 * local writes push to Drive immediately when online.
 */
import {
  putTasks, putNotes, putJournal, getConfig, putConfig,
  putMeta, getAllTasksRaw, getAllNotesRaw, purgeTombstones,
  getDirty, clearDirty, putAudio, getAllAudio,
} from './db'
import {
  getDriveFileIds, readJsonFile, writeJsonFile,
  findFile, writeJsonFile as driveWrite,
  getFileRevisions, getStoredRevisions, setStoredRevisions,
  writeEntityFile, readEntityFile, readEntityFilesBatched, listFolder,
} from './drive'
import { appendChanges, getDeviceId, readManifest, diffManifest, getLocalLastSeq, setLocalLastSeq } from './manifest'
import { migrateDriveEntitiesIfNeeded } from './entitiesMigration'
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
 * Phase B staged merge. Runs `migrateDriveEntitiesIfNeeded` (idempotent), then
 * resolves bucket promises as each stage completes:
 *
 *   Stage 1: manifest read + config + today's journal (resolves `today`, `config`).
 *   Stage 2: tasks + audio meta (resolves `tasks`, `audio`).
 *   Stage 3: notes (resolves `notes`).
 *
 * Each stage uses manifest-diff if `localLastSeq` covers the gap, else
 * cold-start enumeration via `listFolder` + `readEntityFilesBatched`. Local
 * writes pass `{fromSync: true}` to avoid re-marking dirty.
 *
 * `done` resolves with `{ mergedConfig }` once every stage finishes. Callers
 * can await `done` to start the sync engine afterwards.
 */
export function mergeWithDriveStreaming() {
  const buckets = { today: null, tasks: null, audio: null, notes: null, config: null }
  const resolvers = {}
  for (const k of Object.keys(buckets)) {
    buckets[k] = new Promise(r => { resolvers[k] = r })
    buckets[k].catch(() => {})
  }

  const done = (async () => mergeWithDriveImpl(resolvers))()

  return { buckets, done }
}

export async function mergeWithDrive() {
  return mergeWithDriveStreaming().done
}

/**
 * Read the manifest and split changed entities by type. Returns
 * `{ coldStart, headSeq, changedByType: { task, note, audio } }`.
 * On `coldStart`, the caller enumerates the full folder.
 */
async function inspectManifest(rootId) {
  const head = await readManifest(rootId)
  const localLastSeq = await getLocalLastSeq()
  const changedByType = { task: new Map(), note: new Map(), audio: new Map() }
  if (!head) return { coldStart: true, headSeq: 0, changedByType, localLastSeq }
  const headSeq = head.manifest.seq || 0
  const diff = diffManifest(head.manifest, localLastSeq)
  if (diff.gap) return { coldStart: true, headSeq, changedByType, localLastSeq }
  for (const c of diff.changes || []) {
    const bucket = changedByType[c.type]
    if (bucket) bucket.set(c.id, c)
  }
  return { coldStart: false, headSeq, changedByType, localLastSeq }
}

/**
 * Resolve the per-entity docs we need for a bucket: full folder enumeration
 * on cold start, otherwise just the changed ids from the manifest diff.
 */
async function resolveEntityDocs(folderId, coldStart, changedMap) {
  if (coldStart) {
    const files = await listFolder(folderId)
    const entries = files
      .map(f => {
        const m = /^(.+)\.json$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
    return readEntityFilesBatched(folderId, entries)
  }
  const ids = Array.from(changedMap.keys())
  if (!ids.length) return []
  return readEntityFilesBatched(folderId, ids.map(id => ({ id })))
}

/**
 * Apply per-entity tasks: local-only rows are preserved; changed rows merge
 * newer-updatedAt-wins. Deletes flagged in the manifest tombstone locally.
 * Writes go through putTasks with `{fromSync: true}` so the dirty set is left
 * alone.
 */
async function mergeTaskDocs(taskDocs, changedMap) {
  const local = await getAllTasksRaw()
  const localById = new Map(local.map(t => [t.id, t]))
  const writes = []
  for (const { id, doc } of taskDocs) {
    const l = localById.get(id)
    const change = changedMap.get(id)
    if (!doc) {
      if (change?.op === 'delete') {
        writes.push({ id, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localById.delete(id)
      }
      continue
    }
    if (!l) { writes.push(doc); localById.set(id, doc); continue }
    const lt = new Date(l.updatedAt || l.createdAt || 0).getTime()
    const rt = new Date(doc.updatedAt || doc.createdAt || 0).getTime()
    const winner = rt >= lt ? doc : l
    if (winner !== l) writes.push(winner)
    localById.set(id, winner)
  }
  if (writes.length) await putTasks(writes, { fromSync: true })
  return Array.from(localById.values())
}

async function mergeNoteDocs(noteDocs, changedMap) {
  const local = await getAllNotesRaw()
  const localById = new Map(local.map(n => [n.id, n]))
  const writes = []
  for (const { id, doc } of noteDocs) {
    const l = localById.get(id)
    const change = changedMap.get(id)
    if (!doc) {
      if (change?.op === 'delete') {
        writes.push({ id, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localById.delete(id)
      }
      continue
    }
    if (!l) { writes.push(doc); localById.set(id, doc); continue }
    if (l.deleted || doc.deleted) {
      const lt = new Date(l.updatedAt || 0).getTime()
      const rt = new Date(doc.updatedAt || 0).getTime()
      const winner = rt >= lt ? doc : l
      if (winner !== l) writes.push(winner)
      localById.set(id, winner)
      continue
    }
    const merged = mergeById([l], [doc], { mergeBody: true })[0]
    if (merged !== l) writes.push(merged)
    localById.set(id, merged)
  }
  if (writes.length) await putNotes(writes, { fromSync: true })
  return Array.from(localById.values())
}

async function mergeAudioDocs(audioDocs, changedMap) {
  // We don't return a list to the store — the audio UI hydrates from IDB on
  // demand. Apply writes here so transcripts/tombstones land before Stage 2
  // resolves.
  const localAudio = await getAllAudio()
  const localById = new Map(localAudio.map(a => [a.id, a]))
  for (const { id, doc: entry } of audioDocs) {
    const change = changedMap.get(id)
    if (!entry) {
      if (change?.op === 'delete') {
        const local = localById.get(id)
        if (local && !local.deleted) {
          await putAudio({ ...local, deleted: true, deletedAt: change.at }, { fromSync: true })
        }
      }
      continue
    }
    const local = localById.get(id)
    if (!local) {
      await putAudio({
        id: entry.id,
        blob: null,
        mimeType: entry.mimeType || 'audio/webm',
        duration: entry.duration || 0,
        createdAt: entry.createdAt || new Date().toISOString(),
        driveFileId: entry.driveFileId || null,
        transcript: entry.transcript || null,
        transcriptModel: entry.transcriptModel || null,
        transcribedAt: entry.transcribedAt || null,
        transcriptSegments: entry.transcriptSegments || null,
        deleted: entry.deleted || false,
        deletedAt: entry.deletedAt || null,
        sourceType: entry.sourceType || null,
        sourceId: entry.sourceId || null,
        sourceTitle: entry.sourceTitle || null,
      }, { fromSync: true })
      continue
    }
    const localT = new Date(local.transcribedAt || 0).getTime()
    const remoteT = new Date(entry.transcribedAt || 0).getTime()
    const remoteHasTranscript = !!(entry.transcript || (Array.isArray(entry.transcriptSegments) && entry.transcriptSegments.length))
    const localHasTranscript = !!(local.transcript || (Array.isArray(local.transcriptSegments) && local.transcriptSegments.length))
    const takeRemote = (!!entry.transcribedAt && remoteT >= localT) || (remoteHasTranscript && !localHasTranscript)
    const localDelT = new Date(local.deletedAt || 0).getTime()
    const remoteDelT = new Date(entry.deletedAt || 0).getTime()
    const remoteWinsTrash = remoteDelT > localDelT
    if (!takeRemote && !remoteWinsTrash && local.transcribedAt) continue
    await putAudio({
      ...local,
      driveFileId: local.driveFileId || entry.driveFileId || null,
      transcript: takeRemote ? (entry.transcript || null) : local.transcript,
      transcriptModel: takeRemote ? (entry.transcriptModel || null) : local.transcriptModel,
      transcribedAt: takeRemote ? (entry.transcribedAt || null) : local.transcribedAt,
      transcriptSegments: takeRemote ? (entry.transcriptSegments || null) : local.transcriptSegments,
      deleted: remoteWinsTrash ? (entry.deleted || false) : (local.deleted || false),
      deletedAt: remoteWinsTrash ? (entry.deletedAt || null) : (local.deletedAt || null),
      sourceType: entry.sourceType || local.sourceType || null,
      sourceId: entry.sourceId || local.sourceId || null,
      sourceTitle: entry.sourceTitle || local.sourceTitle || null,
    }, { fromSync: true })
  }
}

async function mergeWithDriveImpl(resolvers) {
  const t0 = performance.now()
  const mark = (label, from) => console.log(`[sync] ${label}: ${(performance.now() - from).toFixed(0)}ms`)

  const ids = await getDriveFileIds()
  if (!ids) {
    for (const r of Object.values(resolvers)) r(null)
    return {}
  }
  mark('getDriveFileIds', t0)

  // One-time Drive entities migration (idempotent; flag-gated). Must complete
  // before any stage that touches the manifest or per-entity folders. If it
  // fails partway, flag isn't set and we retry next boot — but the legacy
  // bulk files are still around so the user's data is intact.
  try {
    const tMig = performance.now()
    await migrateDriveEntitiesIfNeeded()
    mark('entities migration', tMig)
  } catch (e) {
    console.warn('[sync] entities migration failed:', e.message || e)
  }

  // Re-fetch ids after migration in case it rewrote drive_files (legacy ids
  // cleared post-migration).
  const idsAfterMig = await getDriveFileIds()
  const rootId = idsAfterMig.rootId
  const tasksFolderId = idsAfterMig.tasksFolderId
  const notesFolderId = idsAfterMig.notesFolderId
  const audioMetaFolderId = idsAfterMig.audioMetaFolderId

  // Inspect manifest once; reuse across stages.
  const tManifest = performance.now()
  const inspection = await inspectManifest(rootId)
  mark(`manifest inspect (coldStart=${inspection.coldStart})`, tManifest)

  // -- Stage 1: config + today's journal (cheap, unblocks Today UI) --
  const stage1 = (async () => {
    const tCfg = performance.now()
    const remoteConfig = await readJsonFile(idsAfterMig.configFileId).catch(() => ({}))
    const localCfg = await getConfig()
    const mergedConfig = { ...(localCfg || {}), ...(remoteConfig || {}) }
    await putConfig(mergedConfig)
    mark('config', tCfg)
    resolvers.config(mergedConfig)
    // `today` resolves alongside config — App.jsx's loadJournal() handles the
    // actual journal merge separately. We just signal that Stage 1 is done.
    resolvers.today(mergedConfig)
    return mergedConfig
  })().catch(err => {
    resolvers.config(null); resolvers.today(null); throw err
  })

  // -- Stage 2: tasks + audio meta (parallel) --
  const stage2 = (async () => {
    await stage1.catch(() => {})
    const tStage = performance.now()
    const [taskDocs, audioDocs] = await Promise.all([
      resolveEntityDocs(tasksFolderId, inspection.coldStart, inspection.changedByType.task),
      resolveEntityDocs(audioMetaFolderId, inspection.coldStart, inspection.changedByType.audio),
    ])
    const mergedTasks = await mergeTaskDocs(taskDocs, inspection.changedByType.task)
    await mergeAudioDocs(audioDocs, inspection.changedByType.audio)
    mark(`stage2 tasks+audio (cold=${inspection.coldStart}, ${taskDocs.length}t/${audioDocs.length}a)`, tStage)
    resolvers.tasks(mergedTasks.filter(t => !t.deleted))
    resolvers.audio(true)
    return mergedTasks
  })().catch(err => {
    resolvers.tasks(null); resolvers.audio(null); throw err
  })

  // -- Stage 3: notes --
  const stage3 = (async () => {
    await stage2.catch(() => {})
    const tStage = performance.now()
    const noteDocs = await resolveEntityDocs(notesFolderId, inspection.coldStart, inspection.changedByType.note)
    const mergedNotes = await mergeNoteDocs(noteDocs, inspection.changedByType.note)
    mark(`stage3 notes (cold=${inspection.coldStart}, ${noteDocs.length}n)`, tStage)
    resolvers.notes(mergedNotes.filter(n => !n.deleted))
    return mergedNotes
  })().catch(err => {
    resolvers.notes(null); throw err
  })

  const [mergedConfig] = await Promise.all([stage1, stage2, stage3])

  // Advance localLastSeq once everything has been applied. On cold start the
  // head seq is the new floor.
  if (inspection.headSeq > inspection.localLastSeq) {
    await setLocalLastSeq(inspection.headSeq).catch(() => {})
  }

  putMeta(LAST_SYNC_KEY, Date.now()).catch(() => {})
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  purgeTombstones(cutoff).catch(() => {})

  mark('TOTAL mergeWithDrive', t0)
  return { mergedConfig }
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
 * Push all dirty tasks to Drive (Phase B per-entity model). Drains the dirty
 * set in db.meta, writes one file per task, then appends a single batched
 * manifest entry. Per-id remote merge: read the remote file, mergeById against
 * the local record, write the winner.
 *
 * Caller is expected to be wrapped in `withRetry` from syncEngine — failures
 * leave the dirty set intact so the next attempt retries the same ids.
 */
export async function pushTasks() {
  const ids = await getDriveFileIds()
  if (!ids?.tasksFolderId) return null
  const dirty = await getDirty('task')
  const dirtyIds = Object.keys(dirty)
  if (dirtyIds.length === 0) return null

  const localTasks = await getAllTasksRaw()
  const localById = new Map(localTasks.map(t => [t.id, t]))
  const deviceId = await getDeviceId()
  const changes = []
  const pushedIds = []

  for (const id of dirtyIds) {
    const local = localById.get(id)
    if (!local) {
      // Local row gone but still dirty — treat as a hard-delete tombstone.
      pushedIds.push(id)
      continue
    }
    // Per-id remote merge keeps concurrent device writes from clobbering.
    const remote = await readEntityFile(ids.tasksFolderId, id)
    const winner = remote
      ? mergeById([local], [remote])[0]
      : local
    await writeEntityFile(ids.tasksFolderId, id, winner)
    changes.push({
      type: 'task',
      id,
      op: winner.deleted ? 'delete' : 'upsert',
      at: new Date().toISOString(),
      deviceId,
    })
    pushedIds.push(id)
  }

  // Clear dirty BEFORE the manifest append. If the manifest write fails the
  // entity files are already authoritative and the next poll on another device
  // will pick them up via cold-start fallback. We don't want to re-push the
  // entities on retry just because the manifest hint failed.
  await clearDirty('task', pushedIds)
  if (changes.length) await appendChanges(ids.rootId, changes)
  return pushedIds.length
}

/**
 * Push all dirty notes to Drive. Same shape as pushTasks but uses block-level
 * body merge (mergeById with mergeBody: true) to preserve concurrent paragraph
 * edits.
 */
export async function pushNotes() {
  const ids = await getDriveFileIds()
  if (!ids?.notesFolderId) return null
  const dirty = await getDirty('note')
  const dirtyIds = Object.keys(dirty)
  if (dirtyIds.length === 0) return null

  const localNotes = await getAllNotesRaw()
  const localById = new Map(localNotes.map(n => [n.id, n]))
  const deviceId = await getDeviceId()
  const changes = []
  const pushedIds = []

  for (const id of dirtyIds) {
    const local = localById.get(id)
    if (!local) { pushedIds.push(id); continue }
    const remote = await readEntityFile(ids.notesFolderId, id)
    const winner = remote
      ? mergeById([local], [remote], { mergeBody: true })[0]
      : local
    await writeEntityFile(ids.notesFolderId, id, winner)
    changes.push({
      type: 'note',
      id,
      op: winner.deleted ? 'delete' : 'upsert',
      at: new Date().toISOString(),
      deviceId,
    })
    pushedIds.push(id)
  }

  await clearDirty('note', pushedIds)
  if (changes.length) await appendChanges(ids.rootId, changes)
  return pushedIds.length
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
