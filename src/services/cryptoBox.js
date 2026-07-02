/**
 * cryptoBox — client-side encryption primitives for at-rest Drive content.
 *
 * Threat model: data-at-rest on Google Drive. Everything written through the
 * drive.js content choke points is sealed with AES-128-GCM using a random key
 * that lives only on the user's devices (raw in local IndexedDB) and is shown
 * once as a recovery key. Google — or anyone with Drive access — sees only
 * opaque ciphertext. Device seizure / local IDB is explicitly out of scope.
 *
 * This module is deliberately dependency-free (only WebCrypto) so it can be
 * unit-tested in bare Node ≥20 via scripts/test-cryptobox.mjs. Key PERSISTENCE
 * (IDB `enc_key_v1`) and LIFECYCLE (enc_meta, enable/unlock/migrate) live in
 * encryption.js, which drives this module's key holder + status registry.
 *
 * Envelope:  "YJE1" magic (4) + IV (12) + AES-GCM ciphertext||tag.
 * The magic is unambiguous vs every legacy format we already store — Automerge
 * bins start 85 6f 4a 83, JSON '{' (0x7b), webm 1A 45 DF A3, ID3 "ID3" (0x49),
 * ogg "OggS" (0x4f) — so a single sniff of byte 0 (0x59 'Y') tells sealed from
 * plaintext. That lets a half-migrated Drive stay fully readable.
 */

// ---- Typed errors -----------------------------------------------------------

/** A keyless/undetermined device tried to read sealed content or write content. */
export class EncLockedError extends Error {
  constructor(message = 'encryption locked') {
    super(message)
    this.name = 'EncLockedError'
  }
}

/** Sealed bytes failed to open — wrong key or corrupt/truncated envelope. */
export class EncCorruptError extends Error {
  constructor(message = 'encrypted content could not be opened') {
    super(message)
    this.name = 'EncCorruptError'
  }
}

/**
 * A recovery key string was malformed or failed its checksum. `code` is one of
 * 'length' | 'char' | 'checksum' so the UI can distinguish a typo (checksum)
 * from garbage (length/char). Distinct from EncCorruptError, which means the
 * key is well-formed but wrong for THIS account (GCM auth fails on keyCheck).
 */
export class RecoveryKeyError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RecoveryKeyError'
    this.code = code
  }
}

// ---- Envelope constants -----------------------------------------------------

const MAGIC = new Uint8Array([0x59, 0x4a, 0x45, 0x31]) // "YJE1"
const IV_LEN = 12 // AES-GCM standard nonce length
const HEADER_LEN = MAGIC.length + IV_LEN

export const KEY_BYTES = 16 // AES-128
const CHECK_BYTES = 4 // SHA-256 prefix appended to the recovery key

// ---- Module state: the key holder + status registry ------------------------

let keyBytes = null // raw Uint8Array(16), or null when no key is loaded
let cryptoKey = null // cached imported CryptoKey, invalidated when keyBytes changes

const STATUSES = new Set(['unlocked', 'plaintext', 'locked', 'undetermined'])
let encStatus = 'undetermined'
const statusListeners = new Set()

/** Current encryption status. See STATUSES for the four values. */
export function getEncStatus() {
  return encStatus
}

/**
 * Set the encryption status and notify listeners on a change. Only encryption.js
 * (lifecycle) and openContent's sniff-lock call this.
 */
export function setEncStatus(next) {
  if (!STATUSES.has(next)) throw new Error(`invalid enc status: ${next}`)
  if (next === encStatus) return
  encStatus = next
  for (const fn of statusListeners) {
    try { fn(next) } catch { /* a listener must never break status propagation */ }
  }
}

/** Subscribe to status changes; returns an unsubscribe fn. */
export function onEncStatusChange(fn) {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

/** Load the raw key bytes (from encryption.js after reading IDB / a recovery key). */
export function setKeyBytes(bytes) {
  keyBytes = bytes instanceof Uint8Array ? bytes : (bytes ? new Uint8Array(bytes) : null)
  cryptoKey = null
}

export function getKeyBytes() {
  return keyBytes
}

export function hasKey() {
  return !!keyBytes
}

/** Drop the in-memory key (e.g. sign-out). Does not touch persisted status. */
export function clearKey() {
  keyBytes = null
  cryptoKey = null
}

async function getCryptoKey() {
  if (!keyBytes) throw new EncLockedError('no encryption key loaded')
  if (!cryptoKey) {
    cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }
  return cryptoKey
}

// ---- Key generation ---------------------------------------------------------

/** A fresh random 128-bit key. */
export function generateKeyBytes() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

// ---- Seal / open (low-level; require a loaded key) --------------------------

/** True if `bytes` carries our envelope magic and is long enough to hold one. */
export function isSealed(bytes) {
  if (!bytes || bytes.length < HEADER_LEN) return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false
  }
  return true
}

/** Encrypt plaintext bytes into a fresh envelope. Throws EncLockedError w/o a key. */
export async function seal(plainBytes) {
  const key = await getCryptoKey()
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes))
  const out = new Uint8Array(HEADER_LEN + cipher.length)
  out.set(MAGIC, 0)
  out.set(iv, MAGIC.length)
  out.set(cipher, HEADER_LEN)
  return out
}

/** Decrypt a sealed envelope. Throws EncCorruptError on wrong key / corruption. */
export async function open(sealedBytes) {
  if (!isSealed(sealedBytes)) throw new EncCorruptError('not a sealed envelope')
  const key = await getCryptoKey()
  const iv = sealedBytes.subarray(MAGIC.length, HEADER_LEN)
  const cipher = sealedBytes.subarray(HEADER_LEN)
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
    return new Uint8Array(plain)
  } catch {
    // GCM auth failure surfaces as an OperationError — either the wrong key or
    // tampered/corrupt bytes. Callers (unlock keyCheck) treat this as "wrong key".
    throw new EncCorruptError('decryption failed (wrong key or corrupt data)')
  }
}

// ---- Policy shims (called by drive.js choke points) -------------------------

/**
 * Seal content for a write according to the current status:
 *   unlocked  → seal
 *   plaintext → passthrough (legacy, encryption not enabled)
 *   locked | undetermined → THROW (fail closed): a device without a key must
 *     NEVER write plaintext content onto an encrypted Drive, or it silently
 *     leaks and re-introduces cleartext the other devices can't tell apart.
 */
export async function sealContent(bytes) {
  if (encStatus === 'unlocked') return seal(bytes)
  if (encStatus === 'plaintext') return bytes
  throw new EncLockedError(`refusing to write content while encryption status is "${encStatus}"`)
}

/**
 * Open content after a read:
 *   sealed + key   → open (may throw EncCorruptError)
 *   sealed, no key → sniff-lock: flip status to locked and THROW EncLockedError
 *     so the merge aborts instead of treating unreadable bytes as missing.
 *   not sealed     → passthrough forever. A plaintext straggler must never brick
 *     reads; keyed devices can't create new ones, so the plaintext set only
 *     shrinks (audit + re-run migration mops up remnants).
 */
export async function openContent(bytes) {
  if (isSealed(bytes)) {
    if (!hasKey()) {
      setEncStatus('locked')
      throw new EncLockedError('encountered sealed content without a key')
    }
    return open(bytes)
  }
  return bytes
}

// ---- Recovery key (Crockford Base32, 16 key bytes + 4 checksum bytes) -------

// Crockford Base32 alphabet: no I, L, O, U — chosen so the human-typed form has
// no ambiguous characters. 20 payload bytes = 160 bits = exactly 32 chars.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(str) {
  let bits = 0
  let value = 0
  const out = []
  for (const ch of str) {
    const idx = CROCKFORD.indexOf(ch)
    if (idx === -1) throw new RecoveryKeyError(`invalid character "${ch}" in recovery key`, 'char')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** Normalize a user-typed key: strip separators/whitespace, uppercase, map the
 *  Crockford-ambiguous characters (O→0, I/L→1) onto their canonical digits. */
function normalizeRecoveryKey(str) {
  return String(str)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

async function checksum(keyBytesIn) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytesIn))
  return digest.subarray(0, CHECK_BYTES)
}

/** Format 16 key bytes as `XXXX-XXXX-…` (8 groups of 4), checksum appended. */
export async function formatRecoveryKey(keyBytesIn) {
  const check = await checksum(keyBytesIn)
  const payload = new Uint8Array(KEY_BYTES + CHECK_BYTES)
  payload.set(keyBytesIn, 0)
  payload.set(check, KEY_BYTES)
  return base32Encode(payload).match(/.{1,4}/g).join('-')
}

/**
 * Parse a user-typed recovery key back to 16 key bytes, verifying the checksum.
 * Throws RecoveryKeyError (code 'length' | 'char' | 'checksum') on any problem —
 * a typo fails the 32-bit checksum instantly, offline, with nothing stored.
 */
export async function parseRecoveryKey(str) {
  const norm = normalizeRecoveryKey(str)
  if (norm.length !== (KEY_BYTES + CHECK_BYTES) * 8 / 5) {
    throw new RecoveryKeyError('recovery key is the wrong length', 'length')
  }
  const payload = base32Decode(norm)
  const key = payload.subarray(0, KEY_BYTES)
  const provided = payload.subarray(KEY_BYTES, KEY_BYTES + CHECK_BYTES)
  const expected = await checksum(key)
  for (let i = 0; i < CHECK_BYTES; i++) {
    if (provided[i] !== expected[i]) {
      throw new RecoveryKeyError('recovery key checksum failed (likely a typo)', 'checksum')
    }
  }
  return new Uint8Array(key) // copy off the payload buffer
}
