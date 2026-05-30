/**
 * Config migration: convert the legacy singleton config.json into an Automerge
 * doc at config/config.bin and register it in the manifest, so settings sync
 * and merge across devices like tasks/notes/journals instead of being a blind
 * last-writer-wins overwrite.
 *
 * Config is a singleton entity (one id, "config"), so there's no per-id folder
 * scan — just seed the single .bin once. Idempotent; gated by
 * meta.automerge_config_v1. The legacy config.json is LEFT IN PLACE for
 * backward-compat with clients that haven't migrated yet (matches the other
 * cutovers).
 */
import { getDriveFileIds, readEntityBinFile, readJsonFile, writeEntityBinFile } from './drive'
import { getMeta, putMeta, getConfig, putConfigWithDoc } from './db'
import { createDoc, loadDoc, saveDoc } from './automergeDoc'
import { appendChanges, readManifest, getDeviceId } from './manifest'

const MIGRATION_FLAG = 'automerge_config_v1'
const CONFIG_ID = 'config'

function nowIso() { return new Date().toISOString() }

export async function migrateConfigToAutomergeIfNeeded() {
  const already = await getMeta(MIGRATION_FLAG)
  if (already) return { skipped: true }

  const ids = await getDriveFileIds()
  if (!ids?.configFolderId) return { skipped: true, reason: 'no config folder' }

  // The manifest must exist — appendChanges throws otherwise, and the config
  // entry is what lets other devices discover the .bin. Phase B creates it.
  const head = await readManifest(ids.rootId)
  if (!head) return { skipped: true, reason: 'manifest not yet created' }

  const log = (...args) => console.log('[automerge-config-migration]', ...args)

  // If the .bin already exists on Drive, another device migrated first — adopt
  // it locally and set the flag. Otherwise seed it from the best config we have
  // (legacy config.json on Drive, falling back to the local row).
  const existingBin = await readEntityBinFile(ids.configFolderId, CONFIG_ID).catch(() => null)
  if (existingBin) {
    const doc = await loadDoc(existingBin)
    const row = {}
    for (const [k, v] of Object.entries(doc)) row[k] = v
    await putConfigWithDoc(row, existingBin, { fromSync: true })
    await putMeta(MIGRATION_FLAG, { completedAt: nowIso(), adopted: true })
    log('adopted existing config.bin')
    return { ok: true, adopted: true }
  }

  const remoteJson = ids.configFileId
    ? await readJsonFile(ids.configFileId).catch(() => null)
    : null
  const localCfg = await getConfig()
  const seed = { ...(localCfg || {}), ...(remoteJson || {}) }

  const doc = await createDoc('config', seed)
  const bytes = await saveDoc(doc)
  await writeEntityBinFile(ids.configFolderId, CONFIG_ID, bytes)
  await putConfigWithDoc(seed, bytes, { fromSync: true })

  const deviceId = await getDeviceId()
  await appendChanges(ids.rootId, [{
    type: 'config', id: CONFIG_ID, op: 'upsert', at: nowIso(), deviceId,
  }])

  await putMeta(MIGRATION_FLAG, { completedAt: nowIso(), seeded: true })
  log('seeded config.bin from config.json')
  return { ok: true, seeded: true }
}
