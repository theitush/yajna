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
  getNoteDocBytes, putNoteWithDoc,
  getJournalDocBytes, putJournalWithDoc, getAllJournals,
  getConfigDocBytes, putConfigWithDoc,
} from './db'
import {
  getDriveFileIds, readJsonFile,
  readEntityFilesBatched, listFolder,
  writeEntityBinFile, readEntityBinFilesBatched, readEntityBinFile,
} from './drive'
import { appendChanges, getDeviceId, readManifest, diffManifest, getLocalLastSeq, setLocalLastSeq } from './manifest'
import { migrateDriveEntitiesIfNeeded } from './entitiesMigration'
import { migrateTasksToAutomergeIfNeeded } from './tasksAutomergeMigration'
import { migrateNotesToAutomergeIfNeeded } from './notesAutomergeMigration'
import { migrateJournalsToAutomergeIfNeeded } from './journalsAutomergeMigration'
import { migrateConfigToAutomergeIfNeeded } from './configAutomergeMigration'
import { migrateAudioInlineIfNeeded } from './audioInlineMigration'
import {
  createDoc, loadDoc, saveDoc, mergeDoc, sharesAncestry,
  applyTaskFields, materializeTaskRow,
  applyNoteFields, materializeNoteRow,
  materializeJournalRow,
  applyConfigFields, materializeConfigRow,
} from './automergeDoc'
import { journalApply, journalMerge } from './automergeWorkerClient'
import { dayKey } from '../lib/dates'

const LAST_SYNC_KEY = 'last_sync'

/**
 * Resolve two disjoint-root Automerge docs (no shared ancestry, so they can't
 * be CRDT-merged) by recency: return whichever was updated last. Ties go to
 * remote so a stale/empty local doc can never beat fresher remote content —
 * this is the heal path for the cross-device staleness bug. `materialize` is
 * the type's row materializer (used only to read `updatedAt`).
 */
function newerDoc(localDoc, remoteDoc, materialize) {
  const lt = new Date(materialize(localDoc)?.updatedAt || 0).getTime()
  const rt = new Date(materialize(remoteDoc)?.updatedAt || 0).getTime()
  return lt > rt ? localDoc : remoteDoc
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
  const changedByType = { task: new Map(), note: new Map(), audio: new Map(), journal: new Map(), config: new Map() }
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
 * Phase C task pull. For each remote-changed id, fetches the `.bin` Automerge
 * doc. The migration deletes `.json` after writing `.bin`, so post-migration
 * `.bin` is the only on-disk format.
 *
 * Returns [{ id, bytes }] where bytes is null on missing (manifest-delete
 * cases — the row is tombstoned in mergeTaskDocs).
 */
export async function resolveTaskDocs(folderId, coldStart, changedMap) {
  let entries = []
  if (coldStart) {
    const files = await listFolder(folderId)
    entries = files
      .map(f => {
        const m = /^(.+)\.bin$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
  } else {
    entries = Array.from(changedMap.keys()).map(id => ({ id, fileId: undefined }))
  }

  if (!entries.length) return []
  return readEntityBinFilesBatched(folderId, entries)
}

/**
 * Resolve the config singleton's Automerge doc. Config has one fixed id
 * ("config"), so this is just: fetch config/config.bin when cold-starting or
 * when the manifest flagged config changed. Returns `{ id, bytes }` or null
 * (no .bin yet / nothing changed).
 */
export async function resolveConfigDoc(folderId, coldStart, changedMap) {
  if (!folderId) return null
  if (!coldStart && !(changedMap && changedMap.size)) return null
  const bytes = await readEntityBinFile(folderId, 'config').catch(() => null)
  return { id: 'config', bytes }
}

/**
 * Merge the remote config doc into the local one (singleton). Mirrors
 * mergeTaskDocs for a single id: shared-ancestry → Automerge.merge; disjoint
 * roots → newer-by-updatedAt (ties to remote); no local bytes → adopt remote
 * and re-apply the local row on top. Persists merged row + bytes and returns
 * the materialized config row, or null if there was nothing to merge.
 */
export async function mergeConfigDoc(configDoc) {
  if (!configDoc || !configDoc.bytes) return null
  const remoteDoc = await loadDoc(configDoc.bytes)
  const localBytes = await getConfigDocBytes()
  const localRow = await getConfig()
  let mergedDoc
  if (localBytes) {
    const localDoc = await loadDoc(localBytes)
    if (await sharesAncestry(localDoc, remoteDoc)) {
      mergedDoc = await mergeDoc(localDoc, remoteDoc)
    } else {
      mergedDoc = newerDoc(localDoc, remoteDoc, materializeConfigRow)
    }
  } else if (localRow && Object.keys(localRow).length) {
    mergedDoc = await applyConfigFields(remoteDoc, localRow)
  } else {
    mergedDoc = remoteDoc
  }
  const mergedBytes = await saveDoc(mergedDoc)
  const mergedRow = materializeConfigRow(mergedDoc)
  await putConfigWithDoc(mergedRow, mergedBytes, { fromSync: true })
  return mergedRow
}

export async function mergeTaskDocs(taskDocs, changedMap) {
  const local = await getAllTasksRaw()
  const localById = new Map(local.map(t => [t.id, t]))
  const writeRows = []
  const writeDocBytes = new Map() // id → bytes
  for (const { id, bytes } of taskDocs) {
    const l = localById.get(id)
    const change = changedMap.get(id)
    if (!bytes) {
      // .bin missing. If the manifest says delete, write a tombstone row so
      // the UI hides it locally too.
      if (change?.op === 'delete') {
        writeRows.push({ id, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localById.delete(id)
      }
      continue
    }

    const remoteDoc = await loadDoc(bytes)

    // Local doc: load if we have bytes and merge (shared Automerge ancestry).
    // If we have NO local bytes, the remote doc is authoritative — adopt it as
    // the base and re-apply the local row's fields on top. We must NOT
    // createDoc() a fresh-root local doc and Automerge.merge it: two docs with
    // disjoint roots don't union their list content, so the merge silently
    // drops the remote's blocks/fields (the cross-device staleness bug).
    const localBytes = await getTaskDocBytes(id)
    let mergedDoc
    if (localBytes) {
      const localDoc = await loadDoc(localBytes)
      // Heal disjoint-root local docs (see mergeJournalDocs for rationale).
      if (await sharesAncestry(localDoc, remoteDoc)) {
        mergedDoc = await mergeDoc(localDoc, remoteDoc)
      } else {
        mergedDoc = newerDoc(localDoc, remoteDoc, materializeTaskRow)
      }
    } else if (l) {
      mergedDoc = await applyTaskFields(remoteDoc, l)
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

/**
 * Phase C note pull. Same shape as resolveTaskDocs: for each remote-changed
 * id (or full folder on cold start), fetch `notes/<id>.bin`.
 *
 * Returns [{ id, bytes }] where bytes is null on missing (manifest-delete
 * cases — handled by mergeNoteDocs as a tombstone).
 */
export async function resolveNoteDocs(folderId, coldStart, changedMap) {
  let entries = []
  if (coldStart) {
    const files = await listFolder(folderId)
    entries = files
      .map(f => {
        const m = /^(.+)\.bin$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
  } else {
    entries = Array.from(changedMap.keys()).map(id => ({ id, fileId: undefined }))
  }

  if (!entries.length) return []
  return readEntityBinFilesBatched(folderId, entries)
}

export async function mergeNoteDocs(noteDocs, changedMap) {
  const local = await getAllNotesRaw()
  const localById = new Map(local.map(n => [n.id, n]))
  const writeRows = []
  const writeDocBytes = new Map()
  for (const { id, bytes } of noteDocs) {
    const l = localById.get(id)
    const change = changedMap.get(id)
    if (!bytes) {
      // .bin missing on remote. If the manifest says delete, write a tombstone
      // row locally so the UI hides the note immediately.
      if (change?.op === 'delete') {
        writeRows.push({ id, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localById.delete(id)
      }
      continue
    }

    const remoteDoc = await loadDoc(bytes)

    // No local bytes → remote is authoritative: adopt it and re-apply the local
    // row's fields on top. Never createDoc()+merge a disjoint-root local doc —
    // that drops the remote's blocks (see mergeTaskDocs for the full rationale).
    const localBytes = await getNoteDocBytes(id)
    let mergedDoc
    if (localBytes) {
      const localDoc = await loadDoc(localBytes)
      // Heal disjoint-root local docs (see mergeJournalDocs for rationale).
      if (await sharesAncestry(localDoc, remoteDoc)) {
        mergedDoc = await mergeDoc(localDoc, remoteDoc)
      } else {
        mergedDoc = newerDoc(localDoc, remoteDoc, materializeNoteRow)
      }
    } else if (l) {
      mergedDoc = await applyNoteFields(remoteDoc, l)
    } else {
      mergedDoc = remoteDoc
    }

    const mergedBytes = await saveDoc(mergedDoc)
    const mergedRow = materializeNoteRow(mergedDoc)
    writeRows.push(mergedRow)
    writeDocBytes.set(id, mergedBytes)
    localById.set(id, mergedRow)
  }

  for (const row of writeRows) {
    const bytes = writeDocBytes.get(row.id)
    if (bytes) {
      await putNoteWithDoc(row, bytes, { fromSync: true })
    } else {
      await putNotes([row], { fromSync: true })
    }
  }
  return Array.from(localById.values())
}

/**
 * Phase C journal pull. On cold start we enumerate the whole journals/ folder
 * (every day this user has ever recorded) so the local IDB matches Drive.
 * Steady state pulls only the dates the manifest says changed.
 *
 * Journal id is the date string (YYYY-MM-DD).
 */
export async function resolveJournalDocs(folderId, coldStart, changedMap) {
  let entries = []
  if (coldStart) {
    const files = await listFolder(folderId)
    entries = files
      .map(f => {
        const m = /^(.+)\.bin$/.exec(f.name || '')
        if (!m || m[1].startsWith('_')) return null
        return { id: m[1], fileId: f.id }
      })
      .filter(Boolean)
  } else {
    entries = Array.from(changedMap.keys()).map(id => ({ id, fileId: undefined }))
  }

  if (!entries.length) return []
  return readEntityBinFilesBatched(folderId, entries)
}

/**
 * Merge journal `.bin` docs into IDB. Same shape as mergeTaskDocs/mergeNoteDocs.
 * Returns the merged rows (currently unused by callers, but kept for symmetry).
 */
export async function mergeJournalDocs(journalDocs, changedMap) {
  const local = await getAllJournals()
  const localByDate = new Map(local.map(d => [d.date, d]))
  const writeRows = []
  const writeDocBytes = new Map()
  for (const { id, bytes } of journalDocs) {
    const l = localByDate.get(id)
    const change = changedMap?.get?.(id)
    if (!bytes) {
      // A journal "delete" isn't really a user-facing concept today, but if a
      // manifest entry says delete and the .bin is gone, treat it as a soft
      // delete so the local row reflects reality. Currently no UI surfaces it.
      if (change?.op === 'delete' && l) {
        writeRows.push({ ...l, deleted: true, deletedAt: change.at, updatedAt: change.at })
        localByDate.delete(id)
      }
      continue
    }

    // Off-thread the load→merge→save chain. Disjoint-root reconcile (the
    // staleness heal) lives inside journalMerge, unchanged.
    const localBytes = await getJournalDocBytes(id)
    const { bytes: mergedBytes, row: mergedRow } =
      await journalMerge({ remoteBytes: bytes, localBytes, localRow: l })
    if (!mergedRow.date) mergedRow.date = id
    writeRows.push(mergedRow)
    writeDocBytes.set(id, mergedBytes)
    localByDate.set(id, mergedRow)
  }

  for (const row of writeRows) {
    const bytes = writeDocBytes.get(row.date)
    if (bytes) {
      await putJournalWithDoc(row, bytes, { fromSync: true })
    } else {
      await putJournal(row, { fromSync: true })
    }
  }
  return Array.from(localByDate.values())
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

  // Phase C notes migration: notes/<id>.json → notes/<id>.bin (Automerge).
  // Same shape as tasks — idempotent, flag-gated, hard cutover.
  try {
    const tMig = performance.now()
    await migrateNotesToAutomergeIfNeeded()
    mark('automerge notes migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge notes migration failed:', e.message || e)
  }

  // Phase C journals migration: journals/<date>.json → <date>.bin (Automerge).
  // Same shape as tasks/notes — idempotent, flag-gated, hard cutover. Falls in
  // line with the cold-start full-folder pull below so a fresh device picks up
  // every day's journal, not just the day the user happens to open.
  try {
    const tMig = performance.now()
    await migrateJournalsToAutomergeIfNeeded()
    mark('automerge journals migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge journals migration failed:', e.message || e)
  }

  // Config migration: config.json → config/config.bin (Automerge singleton).
  // Idempotent; flag-gated. Needs the manifest (Phase B) to exist so the config
  // change is discoverable by other devices.
  try {
    const tMig = performance.now()
    await migrateConfigToAutomergeIfNeeded()
    mark('automerge config migration', tMig)
  } catch (e) {
    console.warn('[sync] automerge config migration failed:', e.message || e)
  }

  // Inline audio metadata into the doc nodes that reference it (and recover
  // orphaned blobs whose meta was lost). Runs after notes+journals are in .bin
  // form since it rewrites those docs in place. Idempotent + flag-gated.
  try {
    const tMig = performance.now()
    await migrateAudioInlineIfNeeded()
    mark('audio inline migration', tMig)
  } catch (e) {
    console.warn('[sync] audio inline migration failed:', e.message || e)
  }

  // Re-fetch ids after migration in case it rewrote drive_files (legacy ids
  // cleared post-migration).
  const idsAfterMig = await getDriveFileIds()
  const rootId = idsAfterMig.rootId
  const tasksFolderId = idsAfterMig.tasksFolderId
  const notesFolderId = idsAfterMig.notesFolderId
  const audioMetaFolderId = idsAfterMig.audioMetaFolderId
  const journalsFolderId = idsAfterMig.journalsFolderId
  const configFolderId = idsAfterMig.configFolderId

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
    // Config is now a per-entity Automerge doc (config/config.bin). Fetch +
    // merge it through the same path as tasks: shared-ancestry merge, else
    // recency heal, else adopt remote. Falls back to the local row if the .bin
    // isn't there yet (pre-migration peer, or write in flight).
    const configDoc = await resolveConfigDoc(configFolderId, inspection.coldStart, inspection.changedByType.config)
    const mergedConfig = (await mergeConfigDoc(configDoc)) || (await getConfig()) || {}
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
      ? (cur, total) => onProgress({ phase: 'cold-start-progress', label: 'notes', current: cur, total })
      : null
    const noteDocs = await resolveNoteDocs(notesFolderId, inspection.coldStart, inspection.changedByType.note)
    if (noteProgress && inspection.coldStart) noteProgress(noteDocs.length, noteDocs.length)
    const mergedNotes = await mergeNoteDocs(noteDocs, inspection.changedByType.note)
    mark(`stage3 notes (cold=${inspection.coldStart}, ${noteDocs.length}n)`, tStage)
    resolvers.notes(mergedNotes.filter(n => !n.deleted))
    return mergedNotes
  })().catch(err => {
    resolvers.notes(null); throw err
  })

  // -- Stage 4: journals --
  // Pulls every journal day on cold start (the missing-old-journals fix) and
  // only the changed dates from the manifest in steady state. Runs in parallel
  // with stage 3; doesn't block any UI-visible bucket (Today's day is already
  // loaded on demand by App.jsx → loadJournal). Once this stage finishes the
  // Sidebar day picker, Search, and tag pool see all historical days.
  const stage4 = (async () => {
    await stage2.catch(() => {})
    const tStage = performance.now()
    const journalProgress = onProgress
      ? (cur, total) => onProgress({ phase: 'cold-start-progress', label: 'journals', current: cur, total })
      : null
    const journalDocs = await resolveJournalDocs(journalsFolderId, inspection.coldStart, inspection.changedByType.journal)
    if (journalProgress && inspection.coldStart) journalProgress(journalDocs.length, journalDocs.length)
    await mergeJournalDocs(journalDocs, inspection.changedByType.journal)
    mark(`stage4 journals (cold=${inspection.coldStart}, ${journalDocs.length}j)`, tStage)
    return journalDocs.length
  })().catch(err => {
    console.warn('[sync] stage4 journals failed:', err?.message || err)
  })

  const [mergedConfig] = await Promise.all([stage1, stage2, stage3, stage4])
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

    // Pick the base doc: our own bytes, else adopt the remote .bin's root, else
    // (first writer) createDoc. Forking a fresh root when a remote already
    // exists breaks Automerge.merge across devices (the staleness bug).
    const existingBytes = await getTaskDocBytes(id)
    let doc
    if (existingBytes) {
      doc = await loadDoc(existingBytes)
    } else {
      const remoteBytes = await readEntityBinFile(ids.tasksFolderId, id).catch(() => null)
      doc = remoteBytes ? await loadDoc(remoteBytes) : await createDoc('task', local)
    }
    doc = await applyTaskFields(doc, local)
    const bytes = await saveDoc(doc)

    // Persist the new bytes locally before uploading so a mid-push crash
    // doesn't leave the remote ahead of local.
    await putTaskWithDoc(local, bytes, { fromSync: true })

    // Blind upload — no pre-merge read. Other devices' edits get folded in
    // on the next pull via Automerge.merge.
    await writeEntityBinFile(ids.tasksFolderId, id, bytes)

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
 * Push all dirty notes to Drive (Phase C — Automerge). Mirrors pushTasks:
 * load-or-create the local Automerge doc, apply the row's fields into it,
 * blind-upload `notes/<id>.bin`. No pre-merge read — Automerge's merge picks
 * up concurrent device edits on the next pull.
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
    if (!local) {
      // Local row gone but still dirty — drop from dirty set; the soft-delete
      // tombstone (if any) was pushed in an earlier iteration.
      pushedIds.push(id)
      continue
    }

    // Base doc: own bytes, else adopt remote .bin root, else createDoc.
    // (Same disjoint-root avoidance as pushTasks/pushJournal.)
    const existingBytes = await getNoteDocBytes(id)
    let doc
    if (existingBytes) {
      doc = await loadDoc(existingBytes)
    } else {
      const remoteBytes = await readEntityBinFile(ids.notesFolderId, id).catch(() => null)
      doc = remoteBytes ? await loadDoc(remoteBytes) : await createDoc('note', local)
    }
    doc = await applyNoteFields(doc, local)
    const bytes = await saveDoc(doc)

    // Persist bytes locally before upload so a mid-push crash can't leave the
    // remote ahead of the local doc.
    await putNoteWithDoc(local, bytes, { fromSync: true })

    await writeEntityBinFile(ids.notesFolderId, id, bytes)

    changes.push({
      type: 'note',
      id,
      op: local.deleted ? 'delete' : 'upsert',
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
 * Push config to Drive (Automerge singleton). Mirrors pushTasks for the single
 * "config" id: drain the dirty flag, base the doc on our own bytes → else the
 * remote .bin root → else createDoc, apply the row's fields, blind-upload
 * config/config.bin, append a manifest entry. No pre-merge read — other
 * devices' concurrent setting edits fold in on the next pull via Automerge.
 *
 * Caller is expected to be wrapped in `withRetry` from syncEngine.
 */
export async function pushConfig() {
  const ids = await getDriveFileIds()
  if (!ids?.configFolderId) return null
  const dirty = await getDirty('config')
  if (!dirty.config) return null

  const local = await getConfig()
  const existingBytes = await getConfigDocBytes()
  let doc
  if (existingBytes) {
    doc = await loadDoc(existingBytes)
  } else {
    const remoteBytes = await readEntityBinFile(ids.configFolderId, 'config').catch(() => null)
    doc = remoteBytes ? await loadDoc(remoteBytes) : await createDoc('config', local || {})
  }
  doc = await applyConfigFields(doc, local || {})
  const bytes = await saveDoc(doc)

  // Persist bytes locally before upload so a mid-push crash can't leave the
  // remote ahead of the local doc.
  await putConfigWithDoc(local || {}, bytes, { fromSync: true })

  await writeEntityBinFile(ids.configFolderId, 'config', bytes)

  // Clear dirty before the manifest append (same rationale as pushTasks).
  await clearDirty('config', ['config'])
  await appendChanges(ids.rootId, [{
    type: 'config', id: 'config', op: 'upsert',
    at: new Date().toISOString(), deviceId: await getDeviceId(),
  }])
  return 1
}

/**
 * Push a per-day journal doc to Drive (Phase C — Automerge). Mirrors
 * pushTasks/pushNotes: load-or-create the local Automerge doc, apply the row's
 * fields into it, blind-upload `journals/<date>.bin`, append a manifest entry.
 * No pre-merge read — Automerge's merge picks up other devices' concurrent
 * edits on the next pull.
 */
export async function pushJournal(dayDoc) {
  if (!dayDoc?.date) {
    console.warn('pushJournal: skipped — dayDoc has no date', dayDoc)
    return null
  }
  const ids = await getDriveFileIds()
  if (!ids?.journalsFolderId) {
    // Drive folder not initialized yet (e.g. called before initDriveStructure
    // during cold-start). Caller must treat null as "skipped, keep local doc".
    return null
  }
  const date = dayKey(dayDoc.date)
  const source = { ...dayDoc, date }

  // Guard: never push a brand-new, never-edited EMPTY day. Opening "today" on a
  // device calls this (loadJournal → mergeAndPushJournal) even when the user has
  // typed nothing. Uploading an empty fresh-root .bin in that moment is the root
  // of the "new mobile entry shows blank on laptop" bug: if the laptop opens the
  // day before the mobile's content has propagated, it mints a disjoint empty
  // root and uploads it; the mobile's real content can then never merge cleanly.
  // Instead, when there are no local bytes and the day is empty, pull-only:
  // adopt the remote .bin if one exists (so the laptop shows what mobile wrote),
  // else do nothing (no upload, nothing to poison).
  const hasLocalBytes = await getJournalDocBytes(date)
  const liveBlocks = Array.isArray(source.blocks) ? source.blocks.filter(b => !b?.deleted).length : 0
  const isEmptyDay = liveBlocks === 0 && !source.reviewedAt
  if (!hasLocalBytes && isEmptyDay) {
    const remoteBytes = await readEntityBinFile(ids.journalsFolderId, date).catch(() => null)
    if (!remoteBytes) return null
    const remoteDoc = await loadDoc(remoteBytes)
    const remoteRow = materializeJournalRow(remoteDoc)
    if (!remoteRow.date) remoteRow.date = date
    await putJournalWithDoc(remoteRow, remoteBytes, { fromSync: true })
    return remoteRow
  }

  // Pick the base doc we apply local fields onto. Priority:
  //   1. our own persisted bytes (shared Automerge ancestry — normal case)
  //   2. the remote .bin if one exists (adopt its root so our upload shares
  //      ancestry with every other device — never fork a disjoint root)
  //   3. only if neither exists are we the first writer → createDoc
  // Minting a fresh-root doc when a remote already exists is what caused the
  // cross-device "0 merged blocks" staleness bug: a disjoint-root doc can't be
  // Automerge.merge'd with the others, so each pull silently drops content.
  // Gather byte inputs on the main thread (IDB + network — non-blocking I/O),
  // then hand the synchronous Automerge load→apply→save chain to the worker so
  // it never freezes the editor. Disjoint-root reconcile (the staleness heal)
  // lives inside journalApply, unchanged. We always read the remote .bin so the
  // worker can detect a disjoint local root, exactly as the inline code did.
  const existingBytes = await getJournalDocBytes(date)
  const remoteBytes = await readEntityBinFile(ids.journalsFolderId, date).catch(() => null)
  const { bytes, row: merged } = await journalApply({ existingBytes, remoteBytes, source })
  if (!merged.date) merged.date = date

  // Persist locally before upload so a mid-push crash can't leave the remote
  // ahead of the local doc.
  await putJournalWithDoc(merged, bytes, { fromSync: true })

  await writeEntityBinFile(ids.journalsFolderId, date, bytes)

  const deviceId = await getDeviceId()
  await appendChanges(ids.rootId, [{
    type: 'journal',
    id: date,
    op: 'upsert',
    at: new Date().toISOString(),
    deviceId,
  }]).catch(() => {})

  // Resolved successfully — drop from the per-day dirty set (the markDirty
  // call inside putJournal on the user-edit path adds an entry here).
  await clearDirty('journal', [date]).catch(() => {})
  return merged
}

/**
 * Back-compat: callers used to distinguish "merge then push" from "push". With
 * Automerge that distinction collapses — pushJournal *is* the merge-and-push.
 */
export const mergeAndPushJournal = pushJournal

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
