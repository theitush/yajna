/**
 * Repro for yajna#28 — the JOURNAL mirror of #26
 * (scripts/repro-push-stale-row-clobber-notes.mjs S3): journal blocks carried
 * NO per-field `_fts`, so `applyJournalFields` overwrote each block field with
 * a hand-rolled loop and the journal merge (`journalMerge` / `journalApply` in
 * src/services/automergeInline.js, both on `mergeDoc` = bare Automerge.merge)
 * resolved a block BOTH devices had edited by Automerge's actor-id pick rather
 * than by time. That is the parked "journal per-block LWW" TODO: the
 * transcript-truncation / reorder-revert class, where the phone's grown
 * transcript loses to the laptop's older truncated copy because of who has the
 * larger actor id.
 *
 * The INVARIANT this encodes — identical to the note one, now shared code:
 *   every block is stamped like a scalar. `applyJournalFields` runs `stampLWW`
 *   on each block with the BLOCK as its own clock (its `updatedAt`, which
 *   stampBlocksFromDoc bumps only when html/order actually changed or the block
 *   was tombstoned), and `mergeJournalLWW` resolves each list element both
 *   parents hold by those stamps, matched by Automerge object id. Newer wins
 *   per field; a block from before stamps existed is the oldest thing there is.
 *   Which blocks EXIST stays on Automerge's append-only list merge.
 *
 * Checks (the same two docs merged two ways):
 *   (A) bare — `Automerge.merge`, i.e. `mergeDoc`, today's journal merge
 *              -> expected FAIL on every same-block conflict
 *   (B) lww  — `mergeJournalLWW` -> expected PASS
 *   (C) the real `journalMerge` from automergeInline.js, bytes in / bytes out,
 *       so the shipped pull path (worker + inline fallback) is proven, not just
 *       the helper.
 *
 * On a tree that predates the fix `mergeJournalLWW` does not exist: (B) and (C)
 * are skipped with a notice and (A)'s failures are the bug, reproduced against
 * the real shipped code.
 *
 * Run: node scripts/repro-journal-block-lww.mjs
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window

const A = await import('@automerge/automerge')
const ms = (iso) => new Date(iso).getTime()

const AM = await import('../src/services/automergeDoc.js')
const { createDoc, applyJournalFields, materializeJournalRow } = AM
const { journalMerge } = await import('../src/services/automergeInline.js')
const hasFix = typeof AM.mergeJournalLWW === 'function'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!pass) failures++
}

const C0 = '2026-09-15T04:00:00.000Z'
const T0 = '2026-09-15T08:00:00.000Z' // last state both devices pushed
const T2 = '2026-09-15T09:14:09.794Z' // earlier concurrent edit
const T3 = '2026-09-15T09:30:00.000Z' // later concurrent edit

const blk = (id, html, updatedAt, order, over = {}) =>
  ({ id, html, deleted: false, updatedAt, order, ...over })
const base = (over = {}) => ({
  date: '2026-09-15', reviewedAt: null, createdAt: C0, updatedAt: T0,
  blocks: [
    blk('b1', '<p>one</p>', T0, 'a0'),
    blk('b2', '<p>two</p>', T0, 'a1'),
    blk('b3', '<p>three</p>', T0, 'a2'),
  ],
  blockComments: { b1: [{ id: 'c1', text: 'note to self', createdAt: C0, updatedAt: C0 }] },
  ...over,
})
const patch = (row, id, at, over) => ({
  ...row, updatedAt: at,
  blocks: row.blocks.map(b => b.id === id ? { ...b, ...over, updatedAt: at } : b),
})
const withHtml = (row, id, html, at) => patch(row, id, at, { html })
const withOrder = (row, id, order, at) => patch(row, id, at, { order })
const withDeleted = (row, id, at) => patch(row, id, at, { deleted: true, html: '' })
const blockOf = (row, id) => (row.blocks || []).find(b => b.id === id)
const htmlOf = (row, id) => blockOf(row, id)?.html

/** Shared ancestor: the day as both devices last pushed it. */
async function ancestorBytes() {
  return A.save(await applyJournalFields(await createDoc('journal', base()), base()))
}
/** Legacy ancestor: a journal doc from before block stamps existed. */
async function legacyAncestorBytes() {
  return A.save(await createDoc('journal', base()))
}

const BARE = async (l, r) => A.merge(A.clone(l), r)

/**
 * One device's doc: the shared ancestor, loaded under a FIXED actor id, with
 * that device's row serialized into it. Fixed actors (local `aaaa`, remote
 * `bbbb`) are what make the actor-id pick deterministic, so the bug reproduces
 * the same way on every run instead of a coin flip.
 */
const deviceDoc = (anc, actor, row) => applyJournalFields(A.load(anc, actor), row)

async function run(label, merge) {
  console.log(`\n=== ${label} ===`)
  const anc = await ancestorBytes()
  const localDoc = (row) => deviceDoc(anc, 'aaaa', row)
  const remoteDoc = (row) => deviceDoc(anc, 'bbbb', row)
  const mergeRow = async (lRow, rRow) => materializeJournalRow(await merge(await localDoc(lRow), await remoteDoc(rRow)))

  // J1 — transcript truncation, the shape the parked TODO named. A voice clip's
  // block holds a partial transcript; the phone's finished (longer) one lands at
  // T3 while the laptop still re-writes the truncated T2 copy. Newest must win,
  // in BOTH directions — under a by-actor-id pick exactly one of these fails.
  {
    const long = '<p>the whole transcript, all of it</p>'
    const short = '<p>the whole transcr</p>'
    const a = await mergeRow(withHtml(base(), 'b2', long, T3), withHtml(base(), 'b2', short, T2))
    check('J1a local transcript at T3 beats remote truncation at T2', htmlOf(a, 'b2') === long, `b2=${htmlOf(a, 'b2')}`)
    const b = await mergeRow(withHtml(base(), 'b2', short, T2), withHtml(base(), 'b2', long, T3))
    check('J1b remote transcript at T3 beats local truncation at T2', htmlOf(b, 'b2') === long, `b2=${htmlOf(b, 'b2')}`)
    check('J1 untouched blocks intact', htmlOf(a, 'b1') === '<p>one</p>' && htmlOf(b, 'b3') === '<p>three</p>')
    check('J1 block clock never runs backwards', ms(blockOf(a, 'b2').updatedAt) >= ms(T3) && ms(blockOf(b, 'b2').updatedAt) >= ms(T3),
      `a=${blockOf(a, 'b2').updatedAt} b=${blockOf(b, 'b2').updatedAt}`)
  }

  // J2 — one device EDITS a block while the other REORDERS: both edits are on
  // the same block element, on different fields plus the shared `updatedAt`.
  // html and order must both survive and the block's own clock must end at the
  // newer of the two — it is the stamp every later merge is decided by, so a
  // clock that resolves backwards silently re-opens this same conflict.
  {
    const edited = '<p>one, rewritten on the phone</p>'
    const a = await mergeRow(withHtml(base(), 'b1', edited, T3), withOrder(base(), 'b1', 'a5', T2))
    check('J2a the edit survives the other device\'s reorder', htmlOf(a, 'b1') === edited, `b1=${htmlOf(a, 'b1')}`)
    check('J2a the reorder survives the other device\'s edit', blockOf(a, 'b1').order === 'a5', `order=${blockOf(a, 'b1').order}`)
    check('J2a block clock is the newer of the two', ms(blockOf(a, 'b1').updatedAt) >= ms(T3), `upd=${blockOf(a, 'b1').updatedAt}`)
    const b = await mergeRow(withOrder(base(), 'b1', 'a5', T2), withHtml(base(), 'b1', edited, T3))
    check('J2b same, edit on the remote', htmlOf(b, 'b1') === edited && blockOf(b, 'b1').order === 'a5', `b1=${htmlOf(b, 'b1')} order=${blockOf(b, 'b1').order}`)
    check('J2b block clock is the newer of the two', ms(blockOf(b, 'b1').updatedAt) >= ms(T3), `upd=${blockOf(b, 'b1').updatedAt}`)
  }

  // J3 — both devices reorder the SAME block (a real same-field conflict on the
  // fractional-index key). The later move must win, both directions.
  {
    const a = await mergeRow(withOrder(base(), 'b3', 'a05', T3), withOrder(base(), 'b3', 'a9', T2))
    check('J3a later reorder (T3) wins', blockOf(a, 'b3').order === 'a05', `order=${blockOf(a, 'b3').order}`)
    const b = await mergeRow(withOrder(base(), 'b3', 'a9', T2), withOrder(base(), 'b3', 'a05', T3))
    check('J3b later reorder (T3) wins from the remote', blockOf(b, 'b3').order === 'a05', `order=${blockOf(b, 'b3').order}`)
  }

  // J4 — a delete and an edit race on the same block. Tombstones are STICKY in
  // both directions: a delete beats an older edit, and an edit does NOT
  // resurrect an older delete. That asymmetry is not the LWW failing, it is
  // what the stamps say — a live block carries no `deleted` key out of
  // stampBlocksFromDoc, so an edit never writes `deleted: false` and its
  // `_fts.deleted` stays at the ancestor floor, losing to any real delete. It
  // is what stops the "deleted block keeps coming back" class, and it holds
  // under the old bare merge too, so this pins behaviour rather than proving
  // the fix. Whether the later edit SHOULD win is #40.
  {
    const a = await mergeRow(withDeleted(base(), 'b2', T3), withHtml(base(), 'b2', '<p>two, edited</p>', T2))
    check('J4a newer delete beats older edit', blockOf(a, 'b2')?.deleted === true, `b2=${JSON.stringify(blockOf(a, 'b2'))}`)
    const b = await mergeRow(withDeleted(base(), 'b2', T2), withHtml(base(), 'b2', '<p>two, edited</p>', T3))
    check('J4b older delete is not resurrected by a newer edit (#40)', blockOf(b, 'b2')?.deleted === true, `b2=${JSON.stringify(blockOf(b, 'b2'))}`)
    check('J4b the newer text survives under the tombstone, so #40 is a re-read not a recovery',
      htmlOf(b, 'b2') === '<p>two, edited</p>', `b2=${htmlOf(b, 'b2')}`)
  }

  // J5 — different blocks edited concurrently: nothing to resolve, both must
  // ship. This is the invariant the block LIST's append-only merge already
  // guarantees; it must keep holding once per-field LWW runs over the elements.
  {
    const a = await mergeRow(withHtml(base(), 'b1', '<p>one, phone</p>', T2), withHtml(base(), 'b3', '<p>three, laptop</p>', T3))
    check('J5 both devices\' different-block edits survive',
      htmlOf(a, 'b1') === '<p>one, phone</p>' && htmlOf(a, 'b3') === '<p>three, laptop</p>',
      `b1=${htmlOf(a, 'b1')} b3=${htmlOf(a, 'b3')}`)
    check('J5 blockComments untouched', a.blockComments?.b1?.[0]?.text === 'note to self', `bc=${JSON.stringify(a.blockComments)}`)
  }

  // J6 — legacy journal docs: blocks written before `_fts` existed. An
  // unstamped block is the oldest thing there is, so a real edit on either side
  // beats it and a delete written now sticks over a legacy live copy. Without
  // this the fix would strand every journal already on Drive.
  {
    const leg = await legacyAncestorBytes()
    if (A.load(leg).blocks[0]._fts) throw new Error('legacy ancestor unexpectedly stamped')
    const legRow = async (lRow, rRow) => materializeJournalRow(
      await merge(await deviceDoc(leg, 'aaaa', lRow), await deviceDoc(leg, 'bbbb', rRow)))
    const a = await legRow(base(), withHtml(base(), 'b1', '<p>one, laptop</p>', T2))
    check('J6a legacy: the remote\'s stamped edit beats an unstamped block', htmlOf(a, 'b1') === '<p>one, laptop</p>', `b1=${htmlOf(a, 'b1')}`)
    const b = await legRow(withHtml(base(), 'b1', '<p>one, phone</p>', T2), base())
    check('J6b legacy: the local\'s stamped edit beats an unstamped block', htmlOf(b, 'b1') === '<p>one, phone</p>', `b1=${htmlOf(b, 'b1')}`)
    const c = await legRow(withDeleted(base(), 'b1', T2), base())
    check('J6c legacy: a delete written now sticks', blockOf(c, 'b1')?.deleted === true, `b1=${JSON.stringify(blockOf(c, 'b1'))}`)
  }

  // J7 — `_fts` is an internal sync structure: it lives inside the Automerge
  // bytes and must never reach the materialized row (which is what IDB and the
  // editor read). Same contract as the note/task `_fts`.
  {
    const a = await mergeRow(withHtml(base(), 'b1', '<p>one, phone</p>', T3), base())
    check('J7 `_fts` never leaks into the row',
      !('_fts' in a) && (a.blocks || []).every(b => !('_fts' in b)),
      `keys=${Object.keys(a).join(',')} blockKeys=${Object.keys(a.blocks?.[0] || {}).join(',')}`)
  }
}

await run('A) bare Automerge.merge (`mergeDoc`, the journal merge before #28) — expected FAIL', BARE)
const bareFailures = failures

let lwwFailures = null
if (hasFix) {
  failures = 0
  await run('B) mergeJournalLWW (per-block wall-clock LWW) — expected PASS', AM.mergeJournalLWW)
  lwwFailures = failures
}

// C) The shipped pull path end to end: bytes in, bytes out, through the real
// journalMerge that the worker (and its inline fallback) calls. Proves the
// wiring, not just the helper.
let shippedFailures = null
if (hasFix) {
  failures = 0
  console.log('\n=== C) the real journalMerge (automergeInline.js), bytes in / bytes out — expected PASS ===')
  const anc = await ancestorBytes()
  const long = '<p>the whole transcript, all of it</p>'
  const localRow = withHtml(base(), 'b2', long, T3)
  const localBytes = A.save(await deviceDoc(anc, 'aaaa', localRow))
  const remoteBytes = A.save(await deviceDoc(anc, 'bbbb', withHtml(base(), 'b2', '<p>the whole transcr</p>', T2)))
  const { row } = await journalMerge({ remoteBytes, localBytes, localRow })
  check('C1 same-block conflict resolves by time through journalMerge', htmlOf(row, 'b2') === long, `b2=${htmlOf(row, 'b2')}`)
  check('C1 the day\'s other blocks survive', htmlOf(row, 'b1') === '<p>one</p>' && htmlOf(row, 'b3') === '<p>three</p>')
  check('C1 blockComments survive', row.blockComments?.b1?.[0]?.text === 'note to self')
  // No local bytes: the remote doc is adopted and the local row applied on top.
  const { row: adopted } = await journalMerge({ remoteBytes, localBytes: null, localRow })
  check('C2 no-local-bytes branch still adopts the remote and applies the row', htmlOf(adopted, 'b2') === long, `b2=${htmlOf(adopted, 'b2')}`)
  shippedFailures = failures
}

console.log('\n=== SUMMARY ===')
console.log(`  A) bare Automerge.merge          failures: ${bareFailures}  (bug reproduced if > 0)`)
console.log(`  B) mergeJournalLWW               failures: ${lwwFailures ?? 'skipped — no mergeJournalLWW in this tree (pre-#28)'}`)
console.log(`  C) real journalMerge             failures: ${shippedFailures ?? 'skipped — no mergeJournalLWW in this tree (pre-#28)'}`)
if (!hasFix) {
  console.log('  RESULT: ✗ bug reproduced against the shipped journal merge; the fix is not in this tree')
  process.exit(1)
}
if (bareFailures > 0 && lwwFailures === 0 && shippedFailures === 0) {
  console.log('  RESULT: ✓ bug reproduced AND per-block LWW proven, helper and shipped path alike')
  process.exit(0)
}
console.log('  RESULT: ✗ unexpected — investigate')
process.exit(1)
