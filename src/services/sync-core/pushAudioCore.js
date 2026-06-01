/**
 * sync-core: portable audio blob push. This is the FIRST sync operation moved
 * off the page so it can run in a service worker after screen-off (see
 * project_sw_push_migration). Audio is the best first consumer: a multi-MB blob,
 * a one-way immutable upload keyed by id, with NO read-merge-write round-trip
 * and NO manifest touch — exactly the "record then pocket the phone" case.
 *
 * It depends only on IDB (getAudio/putAudio), the IDB-cached Drive folder ids
 * (getDriveFileIds → getMeta), and the injected token provider + driveCore raw
 * fetch. No `window`/`document`/`gapi` — safe to import into a worker.
 *
 * The page and the SW call this with their respective providers; the page's
 * pushAudio (audio.js) is now a thin wrapper that injects the page provider, so
 * the upload logic exists in exactly one place.
 */
import { getAudio, putAudio } from '../db'
import { getDriveFileIds } from '../drive'
import { uploadAudioBlob } from './driveCore'
import { logSync } from '../syncLogCore'

/**
 * Upload the local audio blob for `id` to Drive if it isn't already there.
 * Returns the Drive fileId, or null when there's nothing to do (no record, no
 * blob, no provisioned folder, or already uploaded). Idempotent: a record that
 * already has a driveFileId short-circuits, so a retry after a partial
 * screen-off push is safe.
 */
export async function pushAudioWith(provider, id) {
  const ids = await getDriveFileIds()
  if (!ids || !ids.audioFolderId) { logSync('audio push: no-op (no audioFolderId)', { id }); return null }
  const rec = await getAudio(id)
  if (!rec || !rec.blob) { logSync('audio push: no-op (no local blob)', { id, hasRec: !!rec }); return null }
  if (rec.driveFileId) { logSync('audio push: no-op (already uploaded)', { id, driveFileId: rec.driveFileId }); return rec.driveFileId }

  const ext = (rec.mimeType || 'audio/webm').split('/')[1]?.split(';')[0] || 'webm'
  const filename = `${id}.${ext}`
  logSync('audio push: uploading blob', { id, filename, bytes: rec.blob.size })
  const uploaded = await uploadAudioBlob(provider, ids.audioFolderId, filename, rec.blob)
  if (!uploaded?.id) { logSync('audio push: upload returned no id', { id }); return null }

  // Stamp the driveFileId onto the local record so re-uploads short-circuit and
  // offline→online reconciliation (pushPendingAudio) knows it's done.
  await putAudio({ ...rec, driveFileId: uploaded.id, uploadedAt: new Date().toISOString() })
  return uploaded.id
}
