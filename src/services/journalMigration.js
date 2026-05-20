/**
 * One-time Drive migration: split weekly journal files into per-day files.
 *
 * Old layout: `journals/YYYY-Www.json` containing `{ week, entries: { 'YYYY-MM-DD': { blocks, reviewedAt?, blockComments?, ... } } }`,
 * plus a top-level `reviews.json` (date -> reviewedAt ISO).
 *
 * New layout: `journals/YYYY-MM-DD.json` per day, shaped
 *   `{ date, blocks, reviewedAt, blockComments, createdAt, updatedAt }`.
 * `reviews.json` is folded into per-day `reviewedAt` and deleted.
 *
 * Idempotent: gated on `meta.journals_split_v1`. If the flag is set we skip.
 * If a previous run crashed partway, the function detects partial state by
 * inspecting which weekly + reviews files still exist and retries safely
 * (per-day writes use put-by-name, so overwriting is fine).
 */
import {
  readJsonFile, writeJsonFile, deleteDriveFile, getDriveFileIds, findFile,
} from './drive'
import { getMeta, putMeta } from './db'

const MIGRATION_FLAG = 'journals_split_v1'
const BACKUP_FILENAME = '_backup_pre_daily.json'
const WEEKLY_FILENAME_RE = /^\d{4}-W\d{2}\.json$/

const API_TIMEOUT_MS = 30_000
function withTimeout(promise, ms = API_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Drive API call timed out')), ms)),
  ])
}

/**
 * List all files inside a Drive folder (id + name + modifiedTime), paginated.
 */
async function listFolder(folderId) {
  const out = []
  let pageToken = undefined
  do {
    const res = await withTimeout(window.gapi.client.drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      pageToken,
      pageSize: 200,
    }))
    for (const f of res.result.files || []) out.push(f)
    pageToken = res.result.nextPageToken
  } while (pageToken)
  return out
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * Run the migration if it hasn't been completed yet. Safe to call on every
 * boot — it's a fast meta-check when already done.
 */
export async function migrateDriveJournalsIfNeeded() {
  const already = await getMeta(MIGRATION_FLAG)
  if (already) return { skipped: true }

  const ids = await getDriveFileIds()
  if (!ids?.journalsFolderId) return { skipped: true, reason: 'no Drive ids' }

  const t0 = performance.now()
  const log = (...args) => console.log('[journal-migration]', ...args)

  // 1. Snapshot current state of the journals folder + reviews.json.
  const folderFiles = await listFolder(ids.journalsFolderId)
  const weeklyFiles = folderFiles.filter(f => WEEKLY_FILENAME_RE.test(f.name))
  const backupFile = folderFiles.find(f => f.name === BACKUP_FILENAME) || null
  log(`found ${weeklyFiles.length} weekly file(s), backup=${!!backupFile}`)

  let reviewsFileId = ids.reviewsFileId || null
  let reviews = {}
  if (reviewsFileId) {
    try {
      const data = await readJsonFile(reviewsFileId)
      if (data && typeof data === 'object') reviews = data
    } catch (e) {
      log('reviews read failed (will skip):', e.message || e)
      reviewsFileId = null
    }
  }

  // Nothing to do — no legacy weekly files and no reviews. Mark done.
  if (weeklyFiles.length === 0 && Object.keys(reviews).length === 0) {
    await putMeta(MIGRATION_FLAG, { completedAt: nowIso() })
    log('nothing to migrate; flag set')
    return { skipped: true, reason: 'no legacy files' }
  }

  // 2. Read all weekly docs in parallel.
  const weeklyDocs = await Promise.all(weeklyFiles.map(async (f) => {
    try {
      const doc = await readJsonFile(f.id)
      return { file: f, doc }
    } catch (e) {
      log('weekly read failed', f.name, e.message || e)
      return { file: f, doc: null }
    }
  }))

  // 3. Write one combined backup before any destructive step. Skip if a
  // backup already exists (previous partial run).
  if (!backupFile) {
    const backup = {
      createdAt: nowIso(),
      weekly: weeklyDocs.map(({ file, doc }) => ({ name: file.name, doc })),
      reviews,
    }
    await writeJsonFile(ids.journalsFolderId, BACKUP_FILENAME, backup, null)
    log('wrote backup', BACKUP_FILENAME)
  } else {
    log('backup already present; skipping re-create')
  }

  // 4. Build the per-day map from weekly entries.
  const dayMap = new Map()
  for (const { doc } of weeklyDocs) {
    const entries = doc?.entries || {}
    for (const [date, entry] of Object.entries(entries)) {
      if (!date || !entry) continue
      const existing = dayMap.get(date)
      const dayDoc = {
        date,
        blocks: Array.isArray(entry.blocks) ? entry.blocks : [],
        reviewedAt: entry.reviewedAt || null,
        blockComments: entry.blockComments || {},
        createdAt: entry.createdAt || entry.updatedAt || nowIso(),
        updatedAt: entry.updatedAt || entry.createdAt || nowIso(),
      }
      if (!existing) {
        dayMap.set(date, dayDoc)
      } else {
        const winnerTs = (existing.updatedAt || '') >= (dayDoc.updatedAt || '') ? existing : dayDoc
        dayMap.set(date, winnerTs)
      }
    }
  }

  // 5. Fold reviews into matching days (or stub when only a review existed).
  for (const [date, reviewedAt] of Object.entries(reviews || {})) {
    if (!date || !reviewedAt) continue
    const existing = dayMap.get(date)
    if (existing) {
      const winnerTs = (existing.reviewedAt && existing.reviewedAt > reviewedAt) ? existing.reviewedAt : reviewedAt
      dayMap.set(date, { ...existing, reviewedAt: winnerTs })
    } else {
      dayMap.set(date, {
        date,
        blocks: [],
        reviewedAt,
        blockComments: {},
        createdAt: reviewedAt,
        updatedAt: reviewedAt,
      })
    }
  }

  // 6. Write per-day files (idempotent — overwrite if an existing per-day file
  // is present from a previous partial run).
  const existingDailyByName = new Map()
  for (const f of folderFiles) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f.name)) existingDailyByName.set(f.name, f.id)
  }
  let writeCount = 0
  for (const [date, dayDoc] of dayMap.entries()) {
    const filename = `${date}.json`
    const existingId = existingDailyByName.get(filename) || null
    await writeJsonFile(ids.journalsFolderId, filename, dayDoc, existingId)
    writeCount++
  }
  log(`wrote ${writeCount} per-day file(s)`)

  // 7. Delete the original weekly files and reviews.json. Best-effort —
  // failures are tolerable on a retry since the migration flag is only set
  // after all deletes succeed.
  let deleteFailures = 0
  for (const { file } of weeklyDocs) {
    try { await deleteDriveFile(file.id) } catch (e) {
      deleteFailures++
      log('delete weekly failed', file.name, e.message || e)
    }
  }
  if (reviewsFileId) {
    try {
      await deleteDriveFile(reviewsFileId)
    } catch (e) {
      deleteFailures++
      log('delete reviews.json failed', e.message || e)
    }
  }

  // 8. Clear reviewsFileId from the cached drive ids so syncEngine/sync stop
  // touching it. We re-resolve via findFile to be safe.
  try {
    const updatedIds = { ...ids }
    if (reviewsFileId) {
      const stillThere = await findFile(ids.rootId, 'reviews.json')
      updatedIds.reviewsFileId = stillThere || null
    }
    await putMeta('drive_files', updatedIds)
  } catch (e) {
    log('failed to refresh drive_files meta:', e.message || e)
  }

  if (deleteFailures === 0) {
    await putMeta(MIGRATION_FLAG, { completedAt: nowIso(), weeks: weeklyFiles.length, days: dayMap.size })
    log(`done in ${(performance.now() - t0).toFixed(0)}ms`)
    return { ok: true, days: dayMap.size, weeks: weeklyFiles.length }
  }

  log(`partial: ${deleteFailures} delete(s) failed; flag NOT set — will retry next boot`)
  return { ok: false, deleteFailures }
}
