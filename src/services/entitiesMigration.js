/**
 * One-time Drive migration: split bulk entity files into per-id files and
 * initialize manifest.json. Follows the same pattern as journalMigration.js:
 * backup-first, idempotent, completion flag set only after destructive deletes
 * succeed.
 *
 * Old layout:
 *   notes.json   (array of notes)
 *   tasks.json   (array of tasks)
 *   audio.json   (array of audio metadata)
 *
 * New layout:
 *   notes/<id>.json
 *   tasks/<id>.json
 *   audio/meta/<id>.json
 *   manifest.json    (empty changelog; per-entity files carry the state)
 *   _backup_pre_entities.json   (one-shot backup of the three bulk files)
 *
 * Gating: meta.entities_split_v1. If set, skip. On a partial run (writes done
 * but deletes failed), retries pick up cleanly because per-entity writes are
 * by-name and the backup creation is skipped when already present.
 */
import {
  readJsonFile, writeJsonFile, deleteDriveFile, getDriveFileIds,
  findFile, writeEntityFile, listFolder,
} from './drive'
import { getMeta, putMeta } from './db'
import { createManifest, emptyManifest } from './manifest'

const MIGRATION_FLAG = 'entities_split_v1'
const BACKUP_FILENAME = '_backup_pre_entities.json'

function nowIso() { return new Date().toISOString() }

async function readBulkArray(fileId) {
  if (!fileId) return []
  try {
    const data = await readJsonFile(fileId)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/**
 * Build a set of ids already present in a Drive folder (so we can skip
 * re-writing on a retry).
 */
async function existingIdsInFolder(folderId) {
  const files = await listFolder(folderId)
  const ids = new Set()
  for (const f of files) {
    const m = /^(.+)\.json$/.exec(f.name || '')
    if (m && !m[1].startsWith('_')) ids.add(m[1])
  }
  return ids
}

export async function migrateDriveEntitiesIfNeeded() {
  const already = await getMeta(MIGRATION_FLAG)
  if (already) return { skipped: true }

  const ids = await getDriveFileIds()
  if (!ids?.rootId) return { skipped: true, reason: 'no Drive ids' }
  if (!ids.notesFolderId || !ids.tasksFolderId || !ids.audioMetaFolderId) {
    return { skipped: true, reason: 'Phase B folders not provisioned' }
  }

  const t0 = performance.now()
  const log = (...args) => console.log('[entities-migration]', ...args)

  // 1. Snapshot the legacy bulk files. After Phase B has run elsewhere these
  // may already be gone; treat missing as empty.
  const [notesArr, tasksArr, audioArr] = await Promise.all([
    readBulkArray(ids.notesFileId),
    readBulkArray(ids.tasksFileId),
    readBulkArray(ids.audioIndexFileId),
  ])
  log(`legacy bulk: ${notesArr.length} notes, ${tasksArr.length} tasks, ${audioArr.length} audio`)

  // Nothing to migrate AND no bulk files exist → just init manifest + flag.
  const hasAnyLegacy = !!(ids.notesFileId || ids.tasksFileId || ids.audioIndexFileId)
  const hasAnyData = notesArr.length + tasksArr.length + audioArr.length > 0
  if (!hasAnyLegacy && !hasAnyData) {
    // Fresh install: ensure manifest exists, set flag, done.
    const existing = await findFile(ids.rootId, 'manifest.json')
    if (!existing) await createManifest(ids.rootId, emptyManifest())
    await putMeta(MIGRATION_FLAG, { completedAt: nowIso(), fresh: true })
    log('fresh install; flag set')
    return { skipped: true, reason: 'no legacy data' }
  }

  // 2. Write the one-shot combined backup before any destructive step. Skip
  // if a backup is already present from a previous partial run.
  const existingBackupId = await findFile(ids.rootId, BACKUP_FILENAME)
  if (!existingBackupId) {
    const backup = {
      createdAt: nowIso(),
      notes: notesArr,
      tasks: tasksArr,
      audio: audioArr,
    }
    await writeJsonFile(ids.rootId, BACKUP_FILENAME, backup, null)
    log(`wrote backup ${BACKUP_FILENAME}`)
  } else {
    log('backup already present; skipping re-create')
  }

  // 3. Resolve which per-entity files already exist (idempotency for retries).
  const [existingNotes, existingTasks, existingAudio] = await Promise.all([
    existingIdsInFolder(ids.notesFolderId),
    existingIdsInFolder(ids.tasksFolderId),
    existingIdsInFolder(ids.audioMetaFolderId),
  ])

  // 4. Write per-entity files. Skip ones already present from a partial run.
  // Use small batches to avoid hammering Drive on huge accounts.
  const writeBatch = async (folderId, items, existingSet, label) => {
    let written = 0, skipped = 0
    const batchSize = 10
    for (let i = 0; i < items.length; i += batchSize) {
      const slice = items.slice(i, i + batchSize)
      await Promise.all(slice.map(async (item) => {
        if (!item?.id) return
        if (existingSet.has(item.id)) { skipped++; return }
        try {
          await writeEntityFile(folderId, item.id, item)
          written++
        } catch (e) {
          log(`write failed ${label}/${item.id}:`, e.message || e)
        }
      }))
    }
    log(`${label}: wrote ${written}, skipped ${skipped} already-present`)
    return written
  }

  await writeBatch(ids.notesFolderId, notesArr, existingNotes, 'notes')
  await writeBatch(ids.tasksFolderId, tasksArr, existingTasks, 'tasks')
  await writeBatch(ids.audioMetaFolderId, audioArr, existingAudio, 'audio/meta')

  // 5. Initialize the manifest if it doesn't exist. Empty changes[] — the
  // per-entity files are the source of truth; the manifest builds up from
  // subsequent writes.
  const manifestId = await findFile(ids.rootId, 'manifest.json')
  if (!manifestId) {
    await createManifest(ids.rootId, emptyManifest())
    log('created manifest.json')
  }

  // 6. Verify counts: per-entity folder file count >= bulk array count. We
  // tolerate folder having MORE (if a prior partial migration wrote some
  // files and then more entities were added locally — unlikely but possible
  // for tasks/notes). Lower than expected means a write failed.
  const [postNotes, postTasks, postAudio] = await Promise.all([
    existingIdsInFolder(ids.notesFolderId),
    existingIdsInFolder(ids.tasksFolderId),
    existingIdsInFolder(ids.audioMetaFolderId),
  ])
  const want = { notes: notesArr.length, tasks: tasksArr.length, audio: audioArr.length }
  const got = { notes: postNotes.size, tasks: postTasks.size, audio: postAudio.size }
  log('verify:', want, '→', got)
  if (got.notes < want.notes || got.tasks < want.tasks || got.audio < want.audio) {
    log('verify failed; flag NOT set — will retry next boot')
    return { ok: false, want, got }
  }

  // 7. Delete the legacy bulk files. Best-effort — the flag is only set after
  // every delete succeeds (or the file is already gone). 404s are swallowed
  // by deleteDriveFile.
  let deleteFailures = 0
  const tryDelete = async (fid, label) => {
    if (!fid) return
    try { await deleteDriveFile(fid) } catch (e) {
      deleteFailures++
      log(`delete ${label} failed:`, e.message || e)
    }
  }
  await tryDelete(ids.notesFileId, 'notes.json')
  await tryDelete(ids.tasksFileId, 'tasks.json')
  await tryDelete(ids.audioIndexFileId, 'audio.json')

  if (deleteFailures > 0) {
    log(`partial: ${deleteFailures} delete(s) failed; flag NOT set — will retry next boot`)
    return { ok: false, deleteFailures }
  }

  // 8. Clear the legacy ids from the cached drive_files meta so the rest of
  // the app stops referring to them.
  try {
    const updated = { ...ids, tasksFileId: null, notesFileId: null, audioIndexFileId: null }
    await putMeta('drive_files', updated)
  } catch (e) {
    log('drive_files refresh failed:', e.message || e)
  }

  await putMeta(MIGRATION_FLAG, {
    completedAt: nowIso(),
    notes: want.notes,
    tasks: want.tasks,
    audio: want.audio,
  })
  log(`done in ${(performance.now() - t0).toFixed(0)}ms`)
  return { ok: true, ...want }
}
