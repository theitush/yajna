/**
 * encryption.js — lifecycle for at-rest Drive encryption. Owns the raw-key IDB
 * persistence (`enc_key_v1`) and the `enc_meta.json` marker, and drives
 * cryptoBox's key holder + status registry. cryptoBox stays WebCrypto-only and
 * unit-testable in bare Node; everything that touches IDB or Drive lives here.
 *
 * Stage 2 scope: DETECTION + UNLOCK.
 *   - initEncryption() resolves the status on connect (all three App.jsx connect
 *     paths, right after initDriveStructure): loads the persisted key, reads
 *     enc_meta, and settles cryptoBox's status to one of
 *     unlocked | plaintext | locked | undetermined.
 *   - unlockWithRecoveryKey() lets a locked device enter the recovery key.
 * Enable / publish / migrate / re-show land in Stage 3-4.
 *
 * enc_meta.json (plaintext, Drive root):
 *   { version, algo, keyCheck: base64(seal("yajna-enc-check-v1")),
 *     createdAt, createdByDevice }
 * It lets a new device detect encryption BEFORE any content I/O and verify an
 * entered key offline against keyCheck. It stays readable (readJsonFile) so a
 * keyless device can find it — the CONTENT is what's sealed, not the marker.
 */
import { getMeta, putMeta } from './db'
import { getDriveFileIds, findFile, readJsonFile, readBinaryFile } from './drive'
import {
  setKeyBytes, hasKey, clearKey, setEncStatus, getEncStatus,
  parseRecoveryKey, open, isSealed, KEY_BYTES, EncCorruptError,
} from './cryptoBox'

const ENC_KEY_IDB = 'enc_key_v1'                 // raw Uint8Array(16), the account key
const ENC_STATUS_CACHE_IDB = 'enc_status_cache'  // last resolved verdict, for offline boots
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
