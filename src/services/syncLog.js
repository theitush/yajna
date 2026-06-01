/**
 * Page-side sync diagnostics: the Drive-flush helper + the `window.*` console
 * aids. The actual ring buffer (logSync/getSyncLog/clearSyncLog) lives in the
 * SW-safe syncLogCore.js and is re-exported here so existing page imports of
 * `./syncLog` keep working unchanged. This module imports drive.js (gapi), so it
 * must NOT be imported from the service worker / sync-core — use syncLogCore
 * there.
 *
 * Workflow when a bug shows up:
 *   1. reproduce / notice it
 *   2. in the console run:  await window.dumpSyncLog()   (or window.flushSyncLogToDrive())
 *   3. paste the output
 *
 * Temporary debug aid — remove once the audio-push migration is verified.
 */
import { getMeta, getAllAudio } from './db'
import { getDriveFileIds, findFile, writeJsonFile, listFolder } from './drive'
import { logSync, getSyncLog, clearSyncLog } from './syncLogCore'

export { logSync, getSyncLog, clearSyncLog }

/**
 * Write this device's sync log to Drive as `_debug_synclog_<deviceId>.json` in
 * the app root folder, so it can be read from any device (e.g. desktop devtools
 * inspecting the mobile device's trace). Overwrites the previous dump.
 * Returns the filename written, or throws.
 */
export async function flushSyncLogToDrive() {
  const ids = await getDriveFileIds()
  if (!ids?.rootId) throw new Error('Drive not connected')
  const deviceId = (await getMeta('device_id')) || 'unknown'
  const name = `_debug_synclog_${deviceId}.json`
  const log = await getSyncLog()
  const payload = {
    deviceId,
    flushedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    entryCount: log.length,
    entries: log,
  }
  const existing = await findFile(ids.rootId, name).catch(() => null)
  await writeJsonFile(ids.rootId, name, payload, existing || null)
  return name
}

if (typeof window !== 'undefined') {
  window.dumpSyncLog = async () => {
    const log = await getSyncLog()
    console.log(JSON.stringify(log, null, 2))
    return log
  }
  window.clearSyncLog = clearSyncLog
  window.flushSyncLogToDrive = flushSyncLogToDrive

  // Audio diagnostic: cross-reference local IDB audio records against the Drive
  // audio/ blob folder and audio/meta/ per-id metadata folder. Tells us in one
  // shot whether "audio not found" is a missing-on-Drive vs missing-locally
  // problem. Temporary debug aid.
  window.auditAudio = async () => {
    const ids = await getDriveFileIds()
    const local = await getAllAudio()
    const blobFiles = ids?.audioFolderId ? await listFolder(ids.audioFolderId) : []
    const metaFiles = ids?.audioMetaFolderId ? await listFolder(ids.audioMetaFolderId) : []
    const metaIds = new Set(metaFiles
      .map(f => /^(.+)\.json$/.exec(f.name || '')?.[1])
      .filter(x => x && !x.startsWith('_')))
    const blobNames = new Set(blobFiles.map(f => f.name).filter(n => n && n !== 'meta'))
    const report = local.map(a => ({
      id: a.id,
      localHasBlob: !!a.blob,
      localHasTranscript: !!a.transcript,
      localDriveFileId: a.driveFileId || null,
      deleted: !!a.deleted,
      metaOnDrive: metaIds.has(a.id),
      blobOnDriveById: a.driveFileId ? blobFiles.some(f => f.id === a.driveFileId) : null,
    }))
    const summary = {
      audioMetaFolderId: ids?.audioMetaFolderId || null,
      audioIndexFileId: ids?.audioIndexFileId || null,
      localCount: local.length,
      driveBlobFileCount: blobNames.size,
      driveMetaFileCount: metaIds.size,
      localMissingBlob: report.filter(r => !r.localHasBlob).length,
      localMissingMetaOnDrive: report.filter(r => !r.metaOnDrive).length,
    }
    console.log('=== AUDIO AUDIT SUMMARY ===')
    console.table([summary])
    console.log('=== PER-AUDIO ===')
    console.table(report)
    return { summary, report }
  }
}
