/**
 * Persistent ring buffer for sync diagnostics. Survives page reloads (stored in
 * IDB meta) so an intermittent cross-device staleness bug can be inspected after
 * the fact instead of requiring someone to watch the console at the exact moment.
 *
 * Workflow when staleness happens:
 *   1. reproduce / notice it
 *   2. in the console run:  await window.dumpSyncLog()
 *   3. paste the output
 *
 * This is a temporary debug aid — remove once the staleness root cause is fixed.
 */
import { getMeta, putMeta, getAllAudio } from './db'
import { getDriveFileIds, findFile, writeJsonFile, listFolder } from './drive'

const LOG_KEY = 'sync_debug_log'
// Retain by time, not count: a dump should be "what happened recently" so the
// repro moment isn't buried under days of routine 1s-poll spam. MAX_ENTRIES is
// just a hard ceiling so a busy hour can't blow up memory/IDB.
const RETENTION_MS = 60 * 60 * 1000 // keep the last hour
const MAX_ENTRIES = 3000

// In-memory mirror so rapid 1s-poll appends don't serialize a full IDB
// read-modify-write each time. Hydrated lazily from IDB on first use.
let buffer = null
let hydrated = false
let flushTimer = null

async function hydrate() {
  if (hydrated) return
  try {
    const stored = await getMeta(LOG_KEY)
    buffer = Array.isArray(stored) ? stored : []
  } catch {
    buffer = []
  }
  hydrated = true
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(async () => {
    flushTimer = null
    try {
      await putMeta(LOG_KEY, buffer)
    } catch { /* best-effort — it's a debug log */ }
  }, 1000)
}

export function logSync(event, data) {
  // Mirror to console for live watching too.
  console.debug(`[sync-debug] ${event}`, data || '')
  // Fire-and-forget IDB persistence.
  ;(async () => {
    await hydrate()
    const now = Date.now()
    buffer.push({ t: new Date(now).toISOString(), event, ...(data || {}) })
    // Drop anything older than the retention window. Entries are appended in
    // time order, so the stale ones are always a prefix — find the first one
    // we keep and splice everything before it in one shot.
    const cutoff = now - RETENTION_MS
    let keepFrom = 0
    while (keepFrom < buffer.length && Date.parse(buffer[keepFrom].t) < cutoff) keepFrom++
    if (keepFrom > 0) buffer.splice(0, keepFrom)
    // Hard ceiling so a single busy hour can't grow unbounded.
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
    scheduleFlush()
  })()
}

export async function getSyncLog() {
  await hydrate()
  return buffer.slice()
}

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

export async function clearSyncLog() {
  buffer = []
  hydrated = true
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  await putMeta(LOG_KEY, [])
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
