/**
 * Phase C tasks migration: convert tasks/<id>.json (Phase B per-entity files)
 * into tasks/<id>.bin (Automerge binary docs) and delete the .json originals.
 * Hard cutover — no dual-write window. User has a separate backup; the
 * pre-Phase-B `_backup_pre_entities.json` at the root still bundles the
 * original task array, so this migration is recoverable.
 *
 * Gating: meta.automerge_tasks_v1. Idempotent — re-runs skip any .bin already
 * present and re-try any .json delete that failed previously. Flag set only
 * after every .json has both a peer .bin and a successful delete.
 *
 * Also seeds the local IDB row's `_doc` field so the first push doesn't have
 * to fetch its own freshly-uploaded bytes back.
 */
import { getDriveFileIds, listFolder, readJsonFile, writeEntityBinFile, findFile, deleteDriveFile } from './drive'
import { getMeta, putMeta, putTaskDocBytes } from './db'
import { createDoc, saveDoc } from './automergeDoc'

const MIGRATION_FLAG = 'automerge_tasks_v1'

function nowIso() { return new Date().toISOString() }

/**
 * Build name→fileId maps for both .json and .bin files in the tasks folder.
 * Single folder enumeration so we don't re-list per file.
 */
async function indexTasksFolder(folderId) {
  const files = await listFolder(folderId)
  const jsonByName = new Map()
  const binIds = new Set()
  for (const f of files) {
    const name = f.name || ''
    if (name.startsWith('_')) continue
    const jm = /^(.+)\.json$/.exec(name)
    if (jm) { jsonByName.set(jm[1], f.id); continue }
    const bm = /^(.+)\.bin$/.exec(name)
    if (bm) binIds.add(bm[1])
  }
  return { jsonByName, binIds }
}

export async function migrateTasksToAutomergeIfNeeded() {
  const already = await getMeta(MIGRATION_FLAG)
  if (already) return { skipped: true }

  const ids = await getDriveFileIds()
  if (!ids?.tasksFolderId) return { skipped: true, reason: 'no tasks folder' }

  // Phase B must have run first — otherwise the per-entity .json files don't
  // exist yet and there's nothing to convert.
  const phaseBDone = !!(await getMeta('entities_split_v1'))
  if (!phaseBDone) return { skipped: true, reason: 'Phase B entities migration not yet complete' }

  const t0 = performance.now()
  const log = (...args) => console.log('[automerge-tasks-migration]', ...args)

  const { jsonByName, binIds } = await indexTasksFolder(ids.tasksFolderId)
  log(`tasks folder: ${jsonByName.size} .json, ${binIds.size} .bin`)

  // Nothing to convert and nothing already converted → fresh install. Set the
  // flag so we don't re-scan on every boot.
  if (jsonByName.size === 0 && binIds.size === 0) {
    await putMeta(MIGRATION_FLAG, { completedAt: nowIso(), fresh: true })
    log('fresh install; flag set')
    return { skipped: true, reason: 'fresh install' }
  }

  // Per-id work: ensure .bin exists, then delete .json. Both steps are
  // idempotent — an id whose .bin already exists skips straight to delete,
  // and deleteDriveFile swallows 404 so a previously-deleted .json is fine.
  // Small batch to be polite to Drive — uploads are heavier than reads.
  let converted = 0
  let deleted = 0
  let failed = 0
  const ids2 = new Set([...jsonByName.keys(), ...binIds])
  const work = Array.from(ids2)
  const batchSize = 5
  for (let i = 0; i < work.length; i += batchSize) {
    const slice = work.slice(i, i + batchSize)
    await Promise.all(slice.map(async (id) => {
      const jsonFileId = jsonByName.get(id)
      const hasBin = binIds.has(id)
      try {
        if (!hasBin) {
          if (!jsonFileId) { failed++; return } // shouldn't happen — id came from one of the sets
          const json = await readJsonFile(jsonFileId)
          if (!json || typeof json !== 'object') { failed++; return }
          const doc = await createDoc('task', json)
          const bytes = await saveDoc(doc)
          await writeEntityBinFile(ids.tasksFolderId, id, bytes)
          await putTaskDocBytes(id, bytes).catch(() => {})
          converted++
        }
        if (jsonFileId) {
          await deleteDriveFile(jsonFileId)
          deleted++
        }
      } catch (e) {
        log(`work failed for ${id}:`, e.message || e)
        failed++
      }
    }))
  }
  log(`converted ${converted}, deleted ${deleted} .json (${failed} failed)`)

  if (failed > 0) {
    log('partial: some operations failed; flag NOT set — will retry next boot')
    return { ok: false, converted, deleted, failed }
  }

  // Verify: every id has a .bin, and zero .json remain.
  const { jsonByName: jsonAfter, binIds: binAfter } = await indexTasksFolder(ids.tasksFolderId)
  if (jsonAfter.size > 0) {
    log(`verify failed: ${jsonAfter.size} .json still present; flag NOT set`)
    return { ok: false, remainingJson: jsonAfter.size }
  }
  if (binAfter.size < ids2.size) {
    log(`verify failed: expected ≥${ids2.size} .bin, found ${binAfter.size}; flag NOT set`)
    return { ok: false, expectedBin: ids2.size, foundBin: binAfter.size }
  }

  await putMeta(MIGRATION_FLAG, {
    completedAt: nowIso(),
    converted,
    deleted,
    totalBin: binAfter.size,
  })
  log(`done in ${(performance.now() - t0).toFixed(0)}ms`)
  return { ok: true, converted, deleted }
}

/**
 * For unit/dev visibility; not part of the boot flow.
 */
export async function _hasTaskBinFor(id) {
  const ids = await getDriveFileIds()
  if (!ids?.tasksFolderId) return false
  return !!(await findFile(ids.tasksFolderId, `${id}.bin`))
}
