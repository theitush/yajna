/**
 * Unit tests for src/services/cryptoBox.js — the client-side encryption
 * primitives. Pure WebCrypto, no IDB/DOM, so it runs in bare Node ≥20 exactly
 * like the repro-*.mjs scripts.
 *
 * Covers: seal/open round-trip, envelope layout, isSealed vs every legacy
 * magic we store, recovery-key round-trip + normalization, typo/transposition
 * detection (checksum), and wrong-key → EncCorruptError.
 *
 * Run: node scripts/test-cryptobox.mjs
 */

import {
  generateKeyBytes, formatRecoveryKey, parseRecoveryKey,
  seal, open, isSealed, sealContent, openContent,
  setKeyBytes, clearKey, setEncStatus, getEncStatus,
  EncLockedError, EncCorruptError, RecoveryKeyError, KEY_BYTES,
} from '../src/services/cryptoBox.js'

let pass = true
function check(label, ok) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) pass = false
}
async function throws(label, fn, ErrType) {
  try {
    await fn()
    check(`${label} (expected throw)`, false)
  } catch (e) {
    check(`${label} → ${e?.name || 'Error'}`, ErrType ? e instanceof ErrType : true)
  }
}
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
const enc = (s) => new TextEncoder().encode(s)

// ---- seal / open round-trip + envelope layout ------------------------------

{
  setKeyBytes(generateKeyBytes())
  const plain = enc('the quick brown fox — ✦ 日本語 ✦')
  const sealed = await seal(plain)

  check('envelope magic is "YJE1"', sealed[0] === 0x59 && sealed[1] === 0x4a && sealed[2] === 0x45 && sealed[3] === 0x31)
  // 4 magic + 12 IV + (plaintext + 16 GCM tag)
  check('envelope length = 4 + 12 + plaintext + 16 tag', sealed.length === 4 + 12 + plain.length + 16)
  check('isSealed(sealed) is true', isSealed(sealed))

  const opened = await open(sealed)
  check('open(seal(x)) === x', bytesEqual(opened, plain))

  // Two seals of the same plaintext differ (fresh random IV each time).
  const sealed2 = await seal(plain)
  check('two seals of same input differ (fresh IV)', !bytesEqual(sealed, sealed2))
  check('but both open to the same plaintext', bytesEqual(await open(sealed2), plain))

  // Empty input still round-trips (tag-only ciphertext).
  const emptySealed = await seal(new Uint8Array(0))
  check('empty input round-trips', bytesEqual(await open(emptySealed), new Uint8Array(0)))
}

// ---- isSealed vs every legacy magic we store -------------------------------

{
  const legacy = {
    automerge: new Uint8Array([0x85, 0x6f, 0x4a, 0x83, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc]),
    json: enc('{"tasks":[]}                        '),
    webm: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]),
    id3: enc('ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'),
    ogg: enc('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'),
  }
  for (const [name, bytes] of Object.entries(legacy)) {
    check(`isSealed(${name}) is false`, isSealed(bytes) === false)
  }
  check('isSealed(too-short) is false', isSealed(new Uint8Array([0x59, 0x4a])) === false)
  check('isSealed(null) is false', isSealed(null) === false)
}

// ---- recovery-key round-trip + normalization -------------------------------

{
  const key = generateKeyBytes()
  const formatted = await formatRecoveryKey(key)
  check('recovery key is 8 groups of 4 (XXXX-XXXX-…)', /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/.test(formatted))
  check('recovery key has 32 base32 chars', formatted.replace(/-/g, '').length === 32)

  const parsed = await parseRecoveryKey(formatted)
  check('parse(format(key)) === key', bytesEqual(parsed, key) && parsed.length === KEY_BYTES)

  // Messy human input: lowercase, spaces for hyphens, ambiguous O/L for 0/1.
  const messy = formatted.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
  check('parse tolerates case / separators / O↔0 / L↔1', bytesEqual(await parseRecoveryKey(messy), key))
}

// ---- typo / transposition detection (checksum) -----------------------------

{
  const key = generateKeyBytes()
  const formatted = await formatRecoveryKey(key)
  const chars = formatted.replace(/-/g, '').split('')

  // Single-char typo: flip one char to a guaranteed-different valid symbol.
  const typo = [...chars]
  typo[5] = typo[5] === 'A' ? 'B' : 'A'
  await throws('single-char typo fails checksum', () => parseRecoveryKey(typo.join('')), RecoveryKeyError)

  // Transposition: swap the first pair of adjacent chars that differ.
  const swap = [...chars]
  for (let i = 0; i < swap.length - 1; i++) {
    if (swap[i] !== swap[i + 1]) { [swap[i], swap[i + 1]] = [swap[i + 1], swap[i]]; break }
  }
  await throws('adjacent transposition fails checksum', () => parseRecoveryKey(swap.join('')), RecoveryKeyError)

  await throws('wrong-length key fails', () => parseRecoveryKey('ABCD-1234'), RecoveryKeyError)
}

// ---- wrong key → EncCorruptError -------------------------------------------

{
  const keyA = generateKeyBytes()
  const keyB = generateKeyBytes()
  setKeyBytes(keyA)
  const sealed = await seal(enc('secret'))
  setKeyBytes(keyB)
  await throws('open with wrong key → EncCorruptError', () => open(sealed), EncCorruptError)

  // Corrupt/truncated envelope → EncCorruptError too.
  setKeyBytes(keyA)
  const tampered = sealed.slice()
  tampered[tampered.length - 1] ^= 0xff
  await throws('tampered ciphertext → EncCorruptError', () => open(tampered), EncCorruptError)
}

// ---- policy shims: sealContent / openContent by status ---------------------

{
  const key = generateKeyBytes()

  // unlocked → seals; round-trips through openContent
  setKeyBytes(key)
  setEncStatus('unlocked')
  const sealedC = await sealContent(enc('payload'))
  check('sealContent(unlocked) produces a sealed envelope', isSealed(sealedC))
  check('openContent(sealed, keyed) round-trips', bytesEqual(await openContent(sealedC), enc('payload')))

  // plaintext → passthrough both ways
  setEncStatus('plaintext')
  const pt = enc('plain')
  check('sealContent(plaintext) passes through', bytesEqual(await sealContent(pt), pt))
  check('openContent(unsealed) passes through', bytesEqual(await openContent(pt), pt))

  // locked / undetermined → sealContent fails closed
  setEncStatus('locked')
  await throws('sealContent(locked) fails closed', () => sealContent(pt), EncLockedError)
  setEncStatus('undetermined')
  await throws('sealContent(undetermined) fails closed', () => sealContent(pt), EncLockedError)

  // sealed content with NO key → sniff-lock: flip to locked + throw
  clearKey()
  setEncStatus('plaintext')
  await throws('openContent(sealed, no key) throws', () => openContent(sealedC), EncLockedError)
  check('openContent sniff-lock flipped status to "locked"', getEncStatus() === 'locked')
}

console.log(pass ? '\nPASS — cryptoBox primitives verified.' : '\nFAIL — see ✗ above.')
process.exit(pass ? 0 : 1)
