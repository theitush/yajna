/**
 * Phase C journals migration: convert journals/<YYYY-MM-DD>.json (Phase A
 * per-day docs) into journals/<YYYY-MM-DD>.bin (Automerge binary) and delete
 * the .json originals. Mirrors the tasks/notes Automerge migrations — hard
 * cutover, no dual-write. Phase A's `journals/_backup_pre_daily.json` is the
 * recoverable baseline.
 *
 * Gating: meta.automerge_journals_v1. Idempotent — re-runs skip any .bin
 * already present and re-try any .json delete that failed previously. Flag
 * set only after every .json has both a peer .bin and a successful delete.
 *
 * Also seeds the local IDB row's `_doc` field so the first push doesn't have
 * to fetch its own freshly-uploaded bytes back.
 */
import { getDriveFileIds, listFolder, readJsonFile, writeEntityBinFile, findFile, deleteDriveFile } from './drive'
import { getMeta, putMeta, putJournalDocBytes } from './db'
import { createDoc, saveDoc } from './automergeDoc'

const MIGRATION_FLAG = 'automerge_journals_v1'

function nowIso() { return new Date().toISOString() }

async function indexJournalsFolder(folderId) {
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

export async function migrateJournalsToAutomergeIfNeeded() {
  const already = await getMeta(MIGRATION_FLAG)
  if (already) return { skipped: true }

  const ids = await getDriveFileIds()
  if (!ids?.journalsFolderId) return { skipped: true, reason: 'no journals folder' }

  // Phase A (per-day split) must have run. Journals are split early enough
  // that this is effectively always true, but keep the guard for symmetry.
  const phaseADone = !!(await getMeta('journals_split_v1'))
  if (!phaseADone) return { skipped: true, reason: 'Phase A journals split not yet complete' }

  const t0 = performance.now()
  const log = (...args) => console.log('[automerge-journals-migration]', ...args)

  const { jsonByName, binIds } = await indexJournalsFolder(ids.journalsFolderId)
  log(`journals folder: ${jsonByName.size} .json, ${binIds.size} .bin`)

  if (jsonByName.size === 0 && binIds.size === 0) {
    await putMeta(MIGRATION_FLAG, { completedAt: nowIso(), fresh: true })
    log('fresh install; flag set')
    return { skipped: true, reason: 'fresh install' }
  }

  let converted = 0
  let deleted = 0
  let failed = 0
  const allIds = new Set([...jsonByName.keys(), ...binIds])
  const work = Array.from(allIds)
  const batchSize = 5
  for (let i = 0; i < work.length; i += batchSize) {
    const slice = work.slice(i, i + batchSize)
    await Promise.all(slice.map(async (id) => {
      const jsonFileId = jsonByName.get(id)
      const hasBin = binIds.has(id)
      try {
        if (!hasBin) {
          if (!jsonFileId) { failed++; return }
          const json = await readJsonFile(jsonFileId)
          if (!json || typeof json !== 'object') { failed++; return }
          // Defensive: ensure the doc carries its date (id is the date string).
          if (!json.date) json.date = id
          const doc = await createDoc('journal', json)
          const bytes = await saveDoc(doc)
          await writeEntityBinFile(ids.journalsFolderId, id, bytes)
          await putJournalDocBytes(id, bytes).catch(() => {})
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

  const { jsonByName: jsonAfter, binIds: binAfter } = await indexJournalsFolder(ids.journalsFolderId)
  if (jsonAfter.size > 0) {
    log(`verify failed: ${jsonAfter.size} .json still present; flag NOT set`)
    return { ok: false, remainingJson: jsonAfter.size }
  }
  if (binAfter.size < allIds.size) {
    log(`verify failed: expected ≥${allIds.size} .bin, found ${binAfter.size}; flag NOT set`)
    return { ok: false, expectedBin: allIds.size, foundBin: binAfter.size }
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

export async function _hasJournalBinFor(id) {
  const ids = await getDriveFileIds()
  if (!ids?.journalsFolderId) return false
  return !!(await findFile(ids.journalsFolderId, `${id}.bin`))
}
