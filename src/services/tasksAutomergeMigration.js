/**
 * Phase C tasks migration: convert tasks/<id>.json (Phase B per-entity files)
 * into tasks/<id>.bin (Automerge binary docs). Dual-write window: this
 * migration creates the .bin files but leaves the .json files in place so an
 * old build on a second device keeps working. The push path also keeps
 * writing .json. A later cleanup session drops both.
 *
 * Gating: meta.automerge_tasks_v1. Idempotent — re-runs skip any .bin already
 * present and only set the flag once every source .json has a matching .bin.
 *
 * Also seeds the local IDB row's `_doc` field so the first push doesn't have
 * to fetch its own freshly-uploaded bytes back.
 */
import { getDriveFileIds, listFolder, readJsonFile, writeEntityBinFile, findFile } from './drive'
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

  // Convert any .json without a matching .bin. Small batch to be polite to
  // Drive — uploads are heavier than reads.
  const toConvert = []
  for (const [id, fileId] of jsonByName) {
    if (!binIds.has(id)) toConvert.push({ id, fileId })
  }

  let written = 0
  let failed = 0
  const batchSize = 5
  for (let i = 0; i < toConvert.length; i += batchSize) {
    const slice = toConvert.slice(i, i + batchSize)
    await Promise.all(slice.map(async ({ id, fileId }) => {
      try {
        const json = await readJsonFile(fileId)
        if (!json || typeof json !== 'object') { failed++; return }
        const doc = await createDoc('task', json)
        const bytes = await saveDoc(doc)
        await writeEntityBinFile(ids.tasksFolderId, id, bytes)
        // Seed local IDB if the row exists, so the first edit doesn't kick
        // off a re-download to materialize the doc.
        await putTaskDocBytes(id, bytes).catch(() => {})
        written++
      } catch (e) {
        log(`convert failed for ${id}:`, e.message || e)
        failed++
      }
    }))
  }
  log(`converted ${written}/${toConvert.length} (${failed} failed)`)

  if (failed > 0) {
    log('partial: some converts failed; flag NOT set — will retry next boot')
    return { ok: false, written, failed }
  }

  // Verify every .json now has a peer .bin. (Re-list because batches that
  // succeeded above won't be in our cached binIds set.)
  const { jsonByName: jsonAfter, binIds: binAfter } = await indexTasksFolder(ids.tasksFolderId)
  for (const id of jsonAfter.keys()) {
    if (!binAfter.has(id)) {
      log(`verify failed: ${id}.bin still missing; flag NOT set`)
      return { ok: false, missing: id }
    }
  }

  await putMeta(MIGRATION_FLAG, {
    completedAt: nowIso(),
    converted: written,
    totalJson: jsonAfter.size,
  })
  log(`done in ${(performance.now() - t0).toFixed(0)}ms`)
  return { ok: true, written }
}

/**
 * For unit/dev visibility; not part of the boot flow.
 */
export async function _hasTaskBinFor(id) {
  const ids = await getDriveFileIds()
  if (!ids?.tasksFolderId) return false
  return !!(await findFile(ids.tasksFolderId, `${id}.bin`))
}
