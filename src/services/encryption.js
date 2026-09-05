/**
 * encryption.js — lifecycle for at-rest Drive encryption. Owns the raw-key IDB
 * persistence (`enc_key_v1`) and the `enc_meta.json` marker, and drives
 * cryptoBox's key holder + status registry. cryptoBox stays WebCrypto-only and
 * unit-testable in bare Node; everything that touches IDB or Drive lives here.
 *
 * Scope:
 *   - initEncryption() resolves the status on connect (all three App.jsx connect
 *     paths, right after initDriveStructure): loads the persisted key, reads
 *     enc_meta, and settles cryptoBox's status to one of
 *     unlocked | plaintext | locked | undetermined. Self-heals a missing
 *     enc_meta from a previously-verified key.
 *   - unlockWithRecoveryKey() lets a locked device enter the recovery key.
 *   - enableEncryption()/publishEncMeta() turn encryption on (Stage 3).
 *   - migrateDriveToEncrypted()/resumeEncMigrationIfNeeded()/
 *     auditPlaintextRemnants() seal pre-existing content (Stage 4).
 *
 * enc_meta.json (plaintext, Drive root):
 *   { version, algo, keyCheck: base64(seal("yajna-enc-check-v1")),
 *     createdAt, createdByDevice }
 * It lets a new device detect encryption BEFORE any content I/O and verify an
 * entered key offline against keyCheck. It stays readable (readJsonFile) so a
 * keyless device can find it — the CONTENT is what's sealed, not the marker.
 */
import { DRIVE_MIME_FOLDER } from '../lib/constants'
import { getMeta, putMeta } from './db'
import {
  getDriveFileIds, findFile, readJsonFile, readBinaryFile, writeJsonFile,
  listFolder, writeBinaryFile, readFileHead, deleteDriveFile,
} from './drive'
import { appendChanges, getDeviceId, readManifest } from './manifest'
import {
  setKeyBytes, getKeyBytes, hasKey, clearKey, setEncStatus, getEncStatus,
  generateKeyBytes, parseRecoveryKey, formatRecoveryKey, seal, open, isSealed,
  KEY_BYTES, EncCorruptError, EncLockedError,
} from './cryptoBox'

const ENC_KEY_IDB = 'enc_key_v1'                 // raw Uint8Array(16), the account key
const ENC_STATUS_CACHE_IDB = 'enc_status_cache'  // last resolved verdict, for offline boots
const ENC_MIGRATE_PENDING_IDB = 'enc_migrate_pending' // { consentDeleteBackups, startedAt } while a migration is owed
const ENC_META_NAME = 'enc_meta.json'
const KEY_CHECK_PLAINTEXT = 'yajna-enc-check-v1'

export const ENC_VERSION = 1
export const ENC_ALGO = 'AES-128-GCM'

// ---- base64 (browser) -------------------------------------------------------

function base64ToBytes(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function bytesToBase64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

// ---- key persistence --------------------------------------------------------

/**
 * Load the raw account key from IDB into cryptoBox's key holder, if present.
 * Returns true when a well-formed key was loaded. This is the ownership that the
 * Stage 1 plan deliberately moved OUT of cryptoBox (so it stays IDB-free): the
 * key lives at rest in local IDB (device-seizure is explicitly out of scope).
 */
export async function loadPersistedKey() {
  const stored = await getMeta(ENC_KEY_IDB)
  let bytes = null
  if (stored instanceof Uint8Array) bytes = stored
  else if (stored instanceof ArrayBuffer) bytes = new Uint8Array(stored)
  if (bytes && bytes.length === KEY_BYTES) {
    setKeyBytes(bytes)
    return true
  }
  return false
}

async function persistKey(bytes) {
  await putMeta(ENC_KEY_IDB, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

// ---- enc_meta ---------------------------------------------------------------

/**
 * Read + parse enc_meta.json from the Drive root. Returns the parsed object, or
 * null when the file genuinely doesn't exist (encryption not enabled). THROWS on
 * a network/read failure so the caller can fall back to the cached verdict
 * instead of misreading a transient outage as "encryption off" and then writing
 * plaintext onto an encrypted Drive.
 */
export async function readEncMeta(rootId = null) {
  const root = rootId || (await getDriveFileIds())?.rootId
  if (!root) return null
  const fileId = await findFile(root, ENC_META_NAME)
  if (!fileId) return null
  return readJsonFile(fileId)
}

/**
 * Verify the currently-loaded key against enc_meta.keyCheck: opening the sealed
 * check-blob must yield the known plaintext. A wrong key GCM-auth-fails inside
 * open() (EncCorruptError) → false. Requires a key already loaded into cryptoBox.
 */
async function verifyKeyCheck(meta) {
  if (!meta?.keyCheck || !hasKey()) return false
  try {
    const sealed = base64ToBytes(meta.keyCheck)
    const opened = await open(sealed)
    return new TextDecoder().decode(opened) === KEY_CHECK_PLAINTEXT
  } catch {
    return false
  }
}

/**
 * Fallback verification when enc_meta is missing/corrupt (the "enc_meta deleted"
 * failure row): test-open config/config.bin with the loaded key. If it's sealed
 * and opens, the key is right. A plaintext (unsealed) config.bin can't verify
 * anything, so we return false rather than persist a possibly-wrong key. Reads
 * RAW bytes (readBinaryFile, not readEntityBinFile) so openContent's status
 * gate doesn't interfere while we're mid-unlock.
 */
async function verifyAgainstConfigBin() {
  const ids = await getDriveFileIds()
  if (!ids?.configFolderId) return false
  const fileId = await findFile(ids.configFolderId, 'config.bin').catch(() => null)
  if (!fileId) return false
  try {
    const raw = await readBinaryFile(fileId)
    if (!isSealed(raw)) return false
    await open(raw) // throws EncCorruptError on the wrong key
    return true
  } catch {
    return false
  }
}

// ---- lifecycle --------------------------------------------------------------

/**
 * Resolve the encryption status for this connect. Called in all three App.jsx
 * connect paths immediately after initDriveStructure(). Returns the resolved
 * status string (also reflected into cryptoBox's registry + listeners).
 *
 *   no enc_meta on Drive          → 'plaintext'  (encryption not enabled)
 *   enc_meta + key verifies       → 'unlocked'
 *   enc_meta + no/ wrong key      → 'locked'     (UnlockScreen; writes fail closed)
 *   Drive unreachable             → cached verdict, else 'undetermined'
 *
 * The verdict is cached in IDB so an offline boot with a valid local key still
 * unlocks (and a keyless one still locks) without reaching Drive.
 */
export async function initEncryption(rootId = null) {
  await loadPersistedKey()

  let meta
  try {
    meta = await readEncMeta(rootId)
  } catch (e) {
    // Couldn't reach Drive to read the marker. Decide from the cached verdict:
    // a device that was 'unlocked'/'locked' last time stays that way (gated by
    // whether it actually holds a key now); 'plaintext' stays plaintext. With no
    // cache at all we fail closed to 'undetermined' — reads sniff-lock, writes
    // throw, so no plaintext can leak onto a Drive we haven't classified.
    console.warn('initEncryption: enc_meta unreachable, using cached verdict:', e?.message || e)
    const cached = await getMeta(ENC_STATUS_CACHE_IDB)
    if (cached === 'plaintext') setEncStatus('plaintext')
    else if (cached === 'unlocked' || cached === 'locked') setEncStatus(hasKey() ? 'unlocked' : 'locked')
    else setEncStatus('undetermined')
    return getEncStatus()
  }

  if (!meta) {
    // No marker on Drive. If this device holds a key it has previously verified
    // against THIS Drive (cached verdict 'unlocked'), the marker was deleted or
    // lost — self-heal by republishing it rather than misclassifying an
    // encrypted Drive as plaintext, which would passthrough-write plaintext
    // content right back onto it. A keyless device can't make this call; it
    // resolves 'plaintext' and the sniff-lock catches it on the first sealed
    // read (unlock then falls back to test-opening config.bin).
    const cached = await getMeta(ENC_STATUS_CACHE_IDB)
    if (hasKey() && cached === 'unlocked') {
      try {
        await publishEncMeta(rootId)
        console.warn('initEncryption: enc_meta.json was missing — republished (self-heal)')
      } catch (e) {
        console.warn('initEncryption: enc_meta self-heal failed (will retry next connect):', e?.message || e)
      }
      setEncStatus('unlocked')
      return getEncStatus()
    }
    setEncStatus('plaintext')
    await putMeta(ENC_STATUS_CACHE_IDB, 'plaintext')
    return getEncStatus()
  }

  // enc_meta present → encryption is ON for this Drive.
  if (!hasKey()) {
    setEncStatus('locked')
    await putMeta(ENC_STATUS_CACHE_IDB, 'locked')
    return getEncStatus()
  }
  if (await verifyKeyCheck(meta)) {
    setEncStatus('unlocked')
    await putMeta(ENC_STATUS_CACHE_IDB, 'unlocked')
  } else {
    // The persisted key doesn't match this Drive's marker (different account, or
    // a rotated key). Drop it and force a re-unlock rather than fail every read.
    clearKey()
    setEncStatus('locked')
    await putMeta(ENC_STATUS_CACHE_IDB, 'locked')
  }
  return getEncStatus()
}

/**
 * Unlock a locked device with a typed/pasted recovery key. Throws:
 *   - RecoveryKeyError (code length|char|checksum) on a malformed key / typo —
 *     detected offline by parseRecoveryKey, nothing stored.
 *   - EncCorruptError when the key is well-formed but wrong for THIS account
 *     (keyCheck / config.bin GCM auth fails).
 * On success the key is persisted, status flips to 'unlocked', and the caller
 * reloads the app (reusing the proven warm-boot path).
 */
export async function unlockWithRecoveryKey(input) {
  const keyBytes = await parseRecoveryKey(input) // throws RecoveryKeyError on typo
  setKeyBytes(keyBytes)

  let ok = false
  const meta = await readEncMeta().catch(() => null)
  if (meta?.keyCheck) ok = await verifyKeyCheck(meta)
  else ok = await verifyAgainstConfigBin() // enc_meta missing/corrupt fallback

  if (!ok) {
    clearKey()
    throw new EncCorruptError('recovery key does not match this account')
  }

  await persistKey(keyBytes)
  setEncStatus('unlocked')
  await putMeta(ENC_STATUS_CACHE_IDB, 'unlocked')
  return true
}

// ---- enable / publish / re-show (Stage 3) -----------------------------------

/**
 * Write enc_meta.json to the Drive root from the currently-loaded key, then
 * verify what actually landed. enc_meta is the durable "encryption is on" marker
 * a fresh device reads before any content I/O; it stays plaintext so a keyless
 * device can still find it (the CONTENT is sealed, not the marker).
 *
 * Post-write race check: two devices can enable at the same time. writeJsonFile
 * is last-writer-wins with no If-Match, so after writing we re-read and confirm
 * the marker on Drive verifies against OUR key. Returns `{ won }` — false means
 * another device's key won the race and the caller must discard ours.
 */
export async function publishEncMeta(rootId = null) {
  const root = rootId || (await getDriveFileIds())?.rootId
  if (!root) throw new Error('publishEncMeta: no Drive root')
  if (!hasKey()) throw new EncLockedError('publishEncMeta: no key loaded')

  const sealedCheck = await seal(new TextEncoder().encode(KEY_CHECK_PLAINTEXT))
  const meta = {
    version: ENC_VERSION,
    algo: ENC_ALGO,
    keyCheck: bytesToBase64(sealedCheck),
    createdAt: new Date().toISOString(),
    createdByDevice: await getDeviceId(),
  }
  const existing = await findFile(root, ENC_META_NAME)
  await writeJsonFile(root, ENC_META_NAME, meta, existing)

  const onDrive = await readEncMeta(root)
  const won = !!(onDrive && (await verifyKeyCheck(onDrive)))
  return { won, meta: onDrive }
}

/**
 * Turn encryption ON for this Drive. Only valid from 'plaintext' (encryption not
 * yet enabled). Generates a fresh random key, publishes enc_meta, persists the
 * key, and flips status to 'unlocked' so every subsequent write seals. Returns
 * the formatted recovery key to show ONCE (there is no other copy).
 *
 * NOTE: this seals content going FORWARD. Pre-existing plaintext files on Drive
 * are migrated by the Stage-4 one-shot migration — enabling on an account that
 * already holds data must be paired with that migration (existing-account
 * enablement is Stage 4). On a brand-new Drive there is nothing to migrate, so
 * maybeAutoEnableOnFreshDrive() calls this directly at first connect.
 *
 * Throws EncCorruptError if another device won the enable race (our key is
 * discarded and status is left 'locked' → the caller surfaces the UnlockScreen).
 */
export async function enableEncryption() {
  if (getEncStatus() !== 'plaintext') {
    throw new Error(`enableEncryption: refusing to enable from status "${getEncStatus()}"`)
  }
  const keyBytes = generateKeyBytes()
  setKeyBytes(keyBytes)

  let result
  try {
    result = await publishEncMeta()
  } catch (e) {
    clearKey()
    throw e
  }
  if (!result.won) {
    // Another device enabled first with a different key. Drop ours; the marker
    // on Drive now belongs to them, so this device must unlock with their key.
    clearKey()
    setEncStatus('locked')
    await putMeta(ENC_STATUS_CACHE_IDB, 'locked')
    throw new EncCorruptError('another device enabled encryption first')
  }

  await persistKey(keyBytes)
  setEncStatus('unlocked')
  await putMeta(ENC_STATUS_CACHE_IDB, 'unlocked')

  // Live nudge so any other running device re-resolves status and locks within
  // one poll. Best-effort: on a brand-new Drive the manifest doesn't exist yet
  // (the first sync creates it) and there's no other device to notify — enc_meta
  // is the durable signal, this just makes cross-device detection near-instant.
  try {
    const root = (await getDriveFileIds())?.rootId
    if (root) {
      await appendChanges(root, [{
        type: 'enc', id: 'enabled', op: 'upsert',
        at: new Date().toISOString(), deviceId: await getDeviceId(),
      }])
    }
  } catch (e) {
    console.warn('enableEncryption: enc nudge append skipped:', e?.message || e)
  }

  return formatRecoveryKey(keyBytes)
}

/**
 * Re-format the loaded key as its recovery-key string, for the "Show recovery
 * key" affordance on an unlocked device. Requires a key in memory (an unlocked
 * device always has one). The key never leaves the device; this only re-renders
 * the same bytes the user was shown when they enabled.
 */
export async function getRecoveryKeyForDisplay() {
  const bytes = getKeyBytes()
  if (!bytes) throw new EncLockedError('no key loaded to display')
  return formatRecoveryKey(bytes)
}

/**
 * Auto-enable encryption on a brand-new Drive, called on the first-connect
 * (redirect) path only. "Fresh" = no manifest.json yet: the entity changelog is
 * created by the first sync, so its absence means there is no pre-existing
 * plaintext content to migrate and enabling now seals everything from the first
 * write. Returns the recovery key to show once, or null when the Drive isn't
 * fresh / isn't plaintext (an existing account waits for the Stage-4 enable +
 * migration flow instead). Never throws into the connect path.
 */
export async function maybeAutoEnableOnFreshDrive(rootId = null) {
  if (getEncStatus() !== 'plaintext') return null
  const root = rootId || (await getDriveFileIds())?.rootId
  if (!root) return null
  try {
    const manifest = await readManifest(root)
    if (manifest) return null // existing account — has a changelog, don't auto-enable
    return await enableEncryption()
  } catch (e) {
    console.warn('maybeAutoEnableOnFreshDrive skipped:', e?.message || e)
    return null
  }
}

// ---- migration / resume / audit (Stage 4) -----------------------------------

const MIGRATE_TIMEOUT_MS = 60_000 // audio blobs can be MBs; the 15s default flakes on slow uplinks
const MIGRATE_BATCH = 10

// The content buckets, in sensitivity order: config (Groq API key) → audio meta
// (full transcripts) → tasks → notes → journals → audio blobs. Root is NOT a
// bucket — manifest/synclogs/enc_meta stay plaintext by design; the legacy root
// files are handled one-by-one in the cleanup pass.
function migrationBuckets(ids) {
  return [
    ['config', ids.configFolderId],
    ['audio meta', ids.audioMetaFolderId],
    ['tasks', ids.tasksFolderId],
    ['notes', ids.notesFolderId],
    ['journals', ids.journalsFolderId],
    ['audio', ids.audioFolderId],
  ].filter(([, id]) => !!id)
}

/**
 * Read one file ({id, name}), seal it in place if it isn't already. PATCH by
 * fileId keeps the Drive fileId stable (audio driveFileId refs keep working)
 * and appends no manifest entry — the content is identical to what the other
 * devices already hold, so forcing them to re-pull hundreds of files would be
 * pure churn (they're locked until they get the key anyway, and merge normally
 * after unlock).
 */
async function sealFileInPlace(file) {
  const raw = await readBinaryFile(file.id, MIGRATE_TIMEOUT_MS)
  if (isSealed(raw)) return 'skipped'
  const sealed = await seal(raw)
  await writeBinaryFile(null, file.name, sealed, file.id, MIGRATE_TIMEOUT_MS)
  return 'sealed'
}

/** The persisted "a migration is owed" marker, or null. Set before enabling on
 *  an existing account so a crash anywhere in the flow auto-resumes next boot. */
export async function hasPendingEncMigration() {
  return (await getMeta(ENC_MIGRATE_PENDING_IDB)) || null
}

/** Arm the crash-safe resume flag. Called by the enable flow BEFORE
 *  enableEncryption(), and by migrateDriveToEncrypted() itself at start. */
export async function armEncMigration(consentDeleteBackups) {
  await putMeta(ENC_MIGRATE_PENDING_IDB, {
    consentDeleteBackups: !!consentDeleteBackups,
    startedAt: new Date().toISOString(),
  })
}

/** Drop the resume flag (enable failed / migration completed clean). */
export async function disarmEncMigration() {
  await putMeta(ENC_MIGRATE_PENDING_IDB, null)
}

/**
 * One-shot pass that seals every plaintext content file already on Drive.
 * Requires 'unlocked'. The caller (store.runEncMigration) is responsible for
 * serialization: sync engine stopped + in-flight pushes drained + UI blocked —
 * we deliberately serialize the whole world instead of locking file-by-file.
 *
 * Idempotent and resumable: every file is sniffed (isSealed → skip) before
 * sealing, so re-running after a crash/failure only touches what's left, and a
 * half-migrated Drive stays fully readable throughout via openContent's sniff.
 * Per-file failures are collected and retried once; any survivor keeps the
 * resume flag set (next boot re-runs) and is reported in the returned summary.
 *
 * Cleanup pass (first, so the most sensitive bulk plaintext dies early and the
 * bucket enumeration below never lists a file we've already deleted):
 *   - root config.json → overwritten with {} once config/config.bin exists
 *     (the legacy file is dead weight kept only for old-version reads; Stage 5
 *     deletes it with its machinery). Left alone if config.bin is missing.
 *   - _backup_pre_entities.json (root) + journals/_backup_pre_daily.json:
 *     deleted with consent (default), else sealed like any other content.
 *
 * Returns { ok, sealed, skipped, deleted, wipedConfig, failures: [{bucket,name,fileId,err}] }.
 */
export async function migrateDriveToEncrypted({ consentDeleteBackups = true, onProgress = null } = {}) {
  if (getEncStatus() !== 'unlocked') {
    throw new EncLockedError(`migrateDriveToEncrypted: requires 'unlocked', got "${getEncStatus()}"`)
  }
  const ids = await getDriveFileIds()
  if (!ids?.rootId) throw new Error('migrateDriveToEncrypted: no Drive ids')

  await armEncMigration(consentDeleteBackups)
  const progress = (p) => { if (onProgress) { try { onProgress(p) } catch { /* UI only */ } } }
  progress({ phase: 'preparing', done: 0, total: 0 })

  let sealed = 0
  let skipped = 0
  let deleted = 0
  let wipedConfig = false
  const failures = []

  // Cleanup: legacy root config.json + the two pre-migration backup dumps.
  const configBinId = await findFile(ids.configFolderId, 'config.bin')
  if (configBinId) {
    const legacyConfigId = await findFile(ids.rootId, 'config.json')
    if (legacyConfigId) {
      const raw = await readBinaryFile(legacyConfigId).catch(() => null)
      const alreadyEmpty = raw && new TextDecoder().decode(raw).trim() === '{}'
      if (!alreadyEmpty) {
        await writeJsonFile(ids.rootId, 'config.json', {}, legacyConfigId)
        wipedConfig = true
      }
    }
  }
  const backups = [
    [ids.rootId, '_backup_pre_entities.json', 'root'],
    [ids.journalsFolderId, '_backup_pre_daily.json', 'journals'],
  ]
  for (const [folderId, name, bucket] of backups) {
    if (!folderId) continue
    const fileId = await findFile(folderId, name)
    if (!fileId) continue
    try {
      if (consentDeleteBackups) {
        await deleteDriveFile(fileId)
        deleted++
      } else {
        const outcome = await sealFileInPlace({ id: fileId, name })
        if (outcome === 'sealed') sealed++
        else skipped++
      }
    } catch (e) {
      failures.push({ bucket, name, fileId, op: consentDeleteBackups ? 'delete' : 'seal', err: String(e?.message || e).slice(0, 140) })
    }
  }

  // Enumerate all buckets up front so progress has a real denominator.
  const buckets = []
  let total = 0
  for (const [label, folderId] of migrationBuckets(ids)) {
    const files = (await listFolder(folderId)).filter(f => f.mimeType !== DRIVE_MIME_FOLDER)
    buckets.push({ label, folderId, files })
    total += files.length
  }

  let done = 0
  for (const { label, files } of buckets) {
    progress({ phase: label, done, total })
    for (let i = 0; i < files.length; i += MIGRATE_BATCH) {
      const slice = files.slice(i, i + MIGRATE_BATCH)
      await Promise.all(slice.map(async (f) => {
        try {
          const outcome = await sealFileInPlace(f)
          if (outcome === 'sealed') sealed++
          else skipped++
        } catch (e) {
          failures.push({ bucket: label, name: f.name, fileId: f.id, op: 'seal', err: String(e?.message || e).slice(0, 140) })
        }
      }))
      done += slice.length
      progress({ phase: label, done, total })
    }
  }

  // One retry pass over the stragglers (transient 5xx / timeouts), sequential to
  // go easy on whatever was rate-limiting us. sealFileInPlace re-sniffs, so a
  // file whose WRITE landed but whose response was lost just skips.
  if (failures.length) {
    progress({ phase: 'retrying failures', done, total })
    const retry = failures.splice(0, failures.length) // drain; survivors re-collect below
    for (const f of retry) {
      try {
        if (f.op === 'delete') {
          await deleteDriveFile(f.fileId)
          deleted++
        } else {
          const outcome = await sealFileInPlace({ id: f.fileId, name: f.name })
          if (outcome === 'sealed') sealed++
          else skipped++
        }
      } catch (e) {
        failures.push({ ...f, err: String(e?.message || e).slice(0, 140) })
      }
    }
  }

  const ok = failures.length === 0
  if (ok) await disarmEncMigration()
  else console.warn('migrateDriveToEncrypted: incomplete —', failures.length, 'file(s) failed; flag stays set for auto-resume')
  return { ok, sealed, skipped, deleted, wipedConfig, failures }
}

/**
 * Boot hook: if a migration was armed but never finished (crash, tab close,
 * network death mid-pass), re-run it. Called on the connect paths after
 * initEncryption() resolves and BEFORE runInitialSync, so migration writes
 * never race the initial merge. Returns the migration summary, or null when
 * there is nothing to resume.
 */
export async function resumeEncMigrationIfNeeded({ onProgress = null } = {}) {
  const flag = await getMeta(ENC_MIGRATE_PENDING_IDB)
  if (!flag) return null
  const status = getEncStatus()
  if (status === 'plaintext') {
    // Armed, but enabling never actually happened (crash between arm and
    // publish). Nothing was ever sealed with a key we'd have kept — clear it.
    await disarmEncMigration()
    return null
  }
  if (status !== 'unlocked') return null // locked/undetermined: keep the flag for a keyed boot
  return migrateDriveToEncrypted({
    consentDeleteBackups: flag.consentDeleteBackups !== false,
    onProgress,
  })
}

/**
 * Settings → "Check for unencrypted files". Sniffs the first 16 bytes of every
 * content file (Range reads — cheap even over hundreds of files) and reports
 * anything without the envelope magic. Root files are checked against the
 * expected-plaintext set instead: manifest.json, enc_meta.json, synclogs, and
 * an empty legacy config.json stub are fine; anything else unsealed is a
 * remnant (e.g. the accepted race: a keyless device pushed a brand-new entity
 * in the seconds before its poll locked it). Re-running the migration mops up.
 *
 * Returns { checked, plaintext: [{ bucket, name, fileId }] }.
 */
export async function auditPlaintextRemnants({ onProgress = null } = {}) {
  const ids = await getDriveFileIds()
  if (!ids?.rootId) throw new Error('auditPlaintextRemnants: no Drive ids')
  const progress = (p) => { if (onProgress) { try { onProgress(p) } catch { /* UI only */ } } }

  const plaintext = []
  let checked = 0

  const targets = []
  for (const [label, folderId] of migrationBuckets(ids)) {
    const files = (await listFolder(folderId)).filter(f => f.mimeType !== DRIVE_MIME_FOLDER)
    for (const f of files) targets.push({ bucket: label, ...f })
  }
  const rootFiles = (await listFolder(ids.rootId)).filter(f => f.mimeType !== DRIVE_MIME_FOLDER)
  for (const f of rootFiles) {
    if (f.name === 'manifest.json' || f.name === ENC_META_NAME) continue
    if (/^_debug_synclog_/.test(f.name)) continue
    targets.push({ bucket: 'root', ...f, isRootConfig: f.name === 'config.json' })
  }

  const total = targets.length
  for (let i = 0; i < targets.length; i += 20) {
    const slice = targets.slice(i, i + 20)
    await Promise.all(slice.map(async (t) => {
      try {
        const head = await readFileHead(t.id)
        checked++
        if (isSealed(head)) return
        // The wiped legacy config stub is expected plaintext — but ONLY as {}.
        // A non-empty config.json is exactly the leak we care about (Groq key).
        if (t.isRootConfig && new TextDecoder().decode(head).trim() === '{}') return
        plaintext.push({ bucket: t.bucket, name: t.name, fileId: t.id })
      } catch (e) {
        // Unreadable ≠ plaintext; surface it as a finding so the user re-runs.
        plaintext.push({ bucket: t.bucket, name: t.name, fileId: t.id, err: String(e?.message || e).slice(0, 140) })
      }
    }))
    progress({ done: Math.min(i + 20, total), total })
  }

  return { checked, plaintext }
}
