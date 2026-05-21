/**
 * Sync service: bidirectional sync between IndexedDB and Google Drive.
 * Strategy: merge local + Drive on connect (newer updatedAt wins per id);
 * local writes push to Drive immediately when online.
 */
import {
  putTasks, putNotes, putJournal, getConfig, putConfig,
  putMeta, getAllTasksRaw, getAllNotesRaw, purgeTombstones,
  getDirty, clearDirty, putAudio, getAllAudio,
  getTaskDocBytes, putTaskWithDoc,
} from './db'
import {
  getDriveFileIds, readJsonFile, writeJsonFile,
  findFile, writeJsonFile as driveWrite,
  getFileRevisions, getStoredRevisions, setStoredRevisions,
  writeEntityFile, readEntityFile, readEntityFilesBatched, listFolder,
  writeEntityBinFile, readEntityBinFile, readEntityBinFilesBatched,
} from './drive'
import { appendChanges, getDeviceId, readManifest, diffManifest, getLocalLastSeq, setLocalLastSeq } from './manifest'
import { migrateDriveEntitiesIfNeeded } from './entitiesMigration'
import { migrateTasksToAutomergeIfNeeded } from './tasksAutomergeMigration'
import { createDoc, loadDoc, saveDoc, mergeDoc, applyTaskFields, materializeTaskRow } from './automergeDoc'
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
export function mergeWithDriveStreaming(onProgress = null) {
  const buckets = { today: null, tasks: null, audio: null, notes: null, config: null }
  const resolvers = {}
  for (const k of Object.keys(buckets)) {
    buckets[k] = new Promise(r => { resolvers[k] = r })
    buckets[k].catch(() => {})
  }

  const done = (async () => mergeWithDriveImpl(resolvers, onProgress))()

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
async function resolveEntityDocs(folderId, coldStart, changedMap, onProgress = null, label = null) {
  if (coldStart) {
    const files = await listFolder(folderId)
    const entries = files
      .map(f => {
        const m = /^(.+)\.json$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
    if (onProgress) onProgress(label, 0, entries.length)
    return readEntityFilesBatched(folderId, entries, 20, (cur, total) => {
      if (onProgress) onProgress(label, cur, total)
    })
  }
  const ids = Array.from(changedMap.keys())
  if (!ids.length) return []
  return readEntityFilesBatched(folderId, ids.map(id => ({ id })))
}

/**
 * Phase C task pull. For each remote-changed id, prefer the `.bin` Automerge
 * doc and fall back to legacy `.json` (which we wrap in a fresh doc) so
 * mid-migration accounts still resolve cleanly. Merges with the local doc
 * via Automerge — commutative + idempotent, so stale pulls cannot clobber.
 * Materializes the merged doc back into the task row and persists both.
 */
export async function resolveTaskDocs(folderId, coldStart, changedMap) {
  // Decide which ids to fetch and which file ids (if known from listFolder).
  let entries = []
  if (coldStart) {
    const files = await listFolder(folderId)
    // Prefer .bin per id; fall back to .json if no .bin exists.
    const binByName = new Map()
    const jsonByName = new Map()
    for (const f of files) {
      const name = f.name || ''
      if (name.startsWith('_')) continue
      let m = /^(.+)\.bin$/.exec(name)
      if (m) { binByName.set(m[1], f.id); continue }
      m = /^(.+)\.json$/.exec(name)
      if (m) jsonByName.set(m[1], f.id)
    }
    const allIds = new Set([...binByName.keys(), ...jsonByName.keys()])
    entries = Array.from(allIds).map(id => ({
      id,
      binFileId: binByName.get(id) || null,
      jsonFileId: jsonByName.get(id) || null,
    }))
  } else {
    entries = Array.from(changedMap.keys()).map(id => ({ id, binFileId: null, jsonFileId: null }))
  }

  // Batched binary reads first.
  const binResults = await readEntityBinFilesBatched(
    folderId,
    entries.map(e => ({ id: e.id, fileId: e.binFileId || undefined })),
  )
  const bytesById = new Map(binResults.map(r => [r.id, r.bytes]))

  // Fall back to .json for any id without bytes.
  const fallbackEntries = entries.filter(e => !bytesById.get(e.id))
  const jsonResults = fallbackEntries.length
    ? await readEntityFilesBatched(
        folderId,
        fallbackEntries.map(e => ({ id: e.id, fileId: e.jsonFileId || undefined })),
      )
    : []
  const jsonById = new Map(jsonResults.map(r => [r.id, r.doc]))

  return entries.map(e => ({
    id: e.id,
    bytes: bytesById.get(e.id) || null,
    json: jsonById.get(e.id) || null,
  }))
}

export async function mergeTaskDocs(taskDocs, changedMap) {
  const local = await getAllTasksRaw()
  const localById = new Map(local.map(t => [t.id, t]))
  const writeRows = []
  const writeDocBytes = new Map() // id → bytes
  for (const { id, bytes, json } of taskDocs) {
    const l = localById.get(id)
    const change = changedMap.get(id)
    if (!bytes && !json) {
      // Both formats missing. If the manifest says delete, write a tombstone
      // row so the UI hides it locally too.
      if (change?.op === 'delete') {
        writeRows.push({ id, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localById.delete(id)
      }
      continue
    }

    // Build the remote doc (real Automerge if .bin, synthesized from .json
    // otherwise so the merge can still happen on a common substrate).
    const remoteDoc = bytes ? await loadDoc(bytes) : await createDoc('task', json)

    // Local doc: load if we have bytes, else seed from the local row so the
    // merge has something to merge into. Pre-migration rows lack `_doc`.
    const localBytes = await getTaskDocBytes(id)
    let mergedDoc
    if (localBytes) {
      const localDoc = await loadDoc(localBytes)
      mergedDoc = await mergeDoc(localDoc, remoteDoc)
    } else if (l) {
      const seedDoc = await createDoc('task', l)
      mergedDoc = await mergeDoc(seedDoc, remoteDoc)
    } else {
      mergedDoc = remoteDoc
    }

    const mergedBytes = await saveDoc(mergedDoc)
    const mergedRow = materializeTaskRow(mergedDoc)
    writeRows.push(mergedRow)
    writeDocBytes.set(id, mergedBytes)
    localById.set(id, mergedRow)
  }

  // Persist each merged row + its bytes atomically (one record per row).
  for (const row of writeRows) {
    const bytes = writeDocBytes.get(row.id)
    if (bytes) {
      await putTaskWithDoc(row, bytes, { fromSync: true })
    } else {
      await putTasks([row], { fromSync: true })
    }
  }
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

async function mergeWithDriveImpl(resolvers, onProgress = null) {
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

  // Phase C tasks migration: converts tasks/<id>.json → tasks/<id>.bin
  // (Automerge binary). Idempotent; flag-gated; runs alongside the dual-write
  // window before any push/pull touches the tasks folder.
  try {
    const tMig = performance.now()
    await migrateTasksToAutomergeIfNeeded()
    mark('automerge tasks migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge tasks migration failed:', e.message || e)
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
  if (inspection.coldStart && onProgress) {
    onProgress({ phase: 'cold-start-begin' })
  }

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
    const progress = onProgress
      ? (label, cur, total) => onProgress({ phase: 'cold-start-progress', label, current: cur, total })
      : null
    const [taskDocs, audioDocs] = await Promise.all([
      resolveTaskDocs(tasksFolderId, inspection.coldStart, inspection.changedByType.task),
      resolveEntityDocs(audioMetaFolderId, inspection.coldStart, inspection.changedByType.audio, progress, 'audio'),
    ])
    if (progress && inspection.coldStart) progress('tasks', taskDocs.length, taskDocs.length)
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
    const noteProgress = onProgress
      ? (label, cur, total) => onProgress({ phase: 'cold-start-progress', label, current: cur, total })
      : null
    const noteDocs = await resolveEntityDocs(notesFolderId, inspection.coldStart, inspection.changedByType.note, noteProgress, 'notes')
    const mergedNotes = await mergeNoteDocs(noteDocs, inspection.changedByType.note)
    mark(`stage3 notes (cold=${inspection.coldStart}, ${noteDocs.length}n)`, tStage)
    resolvers.notes(mergedNotes.filter(n => !n.deleted))
    return mergedNotes
  })().catch(err => {
    resolvers.notes(null); throw err
  })

  const [mergedConfig] = await Promise.all([stage1, stage2, stage3])
  if (inspection.coldStart && onProgress) {
    onProgress({ phase: 'cold-start-done' })
  }

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
 * Push all dirty tasks to Drive (Phase C — Automerge). Drains the dirty set,
 * mutates each task's local Automerge doc with the row's fields, blind-uploads
 * the binary doc to `tasks/<id>.bin`, and dual-writes the legacy `.json` so
 * pre-Phase-C builds on other devices keep working through the dual-write
 * window. Appends a single batched manifest entry.
 *
 * No pre-merge read needed: Automerge's merge is commutative + idempotent, so
 * any other device's concurrent edit will be folded in on the next pull. This
 * replaces the Phase B per-id read-merge-write loop and removes the entire
 * race window around tasks.
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
      // Local row gone but still dirty — nothing to push and no doc to ship.
      // Mark resolved so we don't retry forever; the delete tombstone (if
      // any) already went through a normal local edit and was pushed earlier.
      pushedIds.push(id)
      continue
    }

    // Load or create the local Automerge doc, then apply the row's fields.
    const existingBytes = await getTaskDocBytes(id)
    let doc = existingBytes ? await loadDoc(existingBytes) : await createDoc('task', local)
    doc = await applyTaskFields(doc, local)
    const bytes = await saveDoc(doc)

    // Persist the new bytes locally before uploading so a mid-push crash
    // doesn't leave the remote ahead of local.
    await putTaskWithDoc(local, bytes, { fromSync: true })

    // Blind upload — no pre-merge read. Other devices' edits get folded in
    // on the next pull via Automerge.merge.
    await writeEntityBinFile(ids.tasksFolderId, id, bytes)

    // Dual-write the legacy .json so a pre-Phase-C build on another device
    // keeps seeing fresh data through the dual-write window. Strip the
    // Automerge bytes from the row before serializing.
    try {
      await writeEntityFile(ids.tasksFolderId, id, local)
    } catch (e) {
      // Dual-write failures are non-fatal — .bin is authoritative for new
      // clients. Log and move on.
      console.warn(`[sync] dual-write tasks/${id}.json failed:`, e.message || e)
    }

    changes.push({
      type: 'task',
      id,
      op: local.deleted ? 'delete' : 'upsert',
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
    if (remote && winner === remote) {
      pushedIds.push(id)
      continue
    }
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
