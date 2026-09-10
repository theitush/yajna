/**
 * Repro for yajna#26 — the NOTE mirror of #24 (scripts/repro-push-stale-row-
 * clobber.mjs): `pushNotes` LWW-merged the local doc with the remote .bin and
 * THEN `applyNoteFields(doc, fresh)` re-applied the whole local row on top.
 *
 * Two things go wrong with merge-then-apply for notes:
 *   - scalars (title, tags, deleted): the row's stale value is re-stamped at
 *     the row's older clock over the remote's newer one — exactly #24.
 *   - blocks: worse. Block fields carried NO LWW stamps, so applyNoteFields'
 *     id-keyed pass just overwrote html/order with the local row's copy, stale
 *     or not: the local row's block ALWAYS won. And simply switching to
 *     apply-then-merge would hand a same-block concurrent edit to bare
 *     Automerge.merge, which picks by actor-id, not time.
 *
 * The INVARIANT this encodes:
 *   Row → doc → merge, and every block is stamped like a scalar. applyNoteFields
 *   serializes the row into the LOCAL doc first, writing a per-field `_fts`
 *   inside each block at the block's own clock (its `updatedAt`, bumped only
 *   when it changed); mergeNoteLWW then resolves each list element both parents
 *   hold by those stamps. Newer wins per field, on scalars and inside blocks
 *   alike; a block from before stamps existed is the oldest thing there is.
 *
 * Checks:
 *   (A) OLD order   (merge, then apply row)          -> expected FAIL
 *   (B) FIX         (apply row, then mergeNoteLWW)   -> expected PASS
 *   (C) apply-then-bare-Automerge.merge (no block LWW) -> expected FAIL on the
 *       same-block conflict: proves the block stamps are needed, not just the
 *       reorder. Both S3 directions use fixed actor ids (local `aaaa`, remote
 *       `bbbb`), so actor-id resolution loses exactly one of them —
 *       deterministically.
 *
 * Run: node scripts/repro-push-stale-row-clobber-notes.mjs
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window

const A = await import('@automerge/automerge')
const ms = (iso) => new Date(iso).getTime()

const { createDoc, applyNoteFields, materializeNoteRow, mergeNoteLWW } =
  await import('../src/services/automergeDoc.js')

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!pass) failures++
}

const C0 = '2026-09-08T11:44:14.390Z'
const T0 = '2026-09-08T16:41:38.672Z' // last state both devices pushed
const T1 = '2026-09-09T07:53:09.280Z' // phone's stale row / earlier edit
const T2 = '2026-09-09T09:14:09.794Z' // laptop's later edit
const T3 = '2026-09-09T09:30:00.000Z' // even later

const blk = (id, html, updatedAt, over = {}) => ({ id, html, deleted: false, updatedAt, order: id, ...over })
const base = (over = {}) => ({
  id: 'n1', title: 'orig title', tags: [], createdAt: C0, updatedAt: T0,
  blocks: [blk('b1', '<p>one</p>', T0), blk('b2', '<p>two</p>', T0)],
  ...over,
})
const withBlock = (row, id, html, at) => ({
  ...row, updatedAt: at,
  blocks: row.blocks.map(b => b.id === id ? blk(id, html, at) : b),
})
const htmlOf = (row, id) => row.blocks.find(b => b.id === id)?.html

/** Shared ancestor: as both devices last pushed it (stamped by applyNoteFields). */
async function ancestorBytes() {
  return A.save(await applyNoteFields(await createDoc('note', base()), base()))
}
/** Legacy ancestor: a doc from before block stamps existed (no `_fts` in blocks). */
async function legacyAncestorBytes() {
  const bytes = A.save(await createDoc('note', base()))
  if (A.load(bytes).blocks[0]._fts) throw new Error('legacy ancestor unexpectedly stamped')
  return bytes
}

const MODES = {
  old: { applyFirst: false, merge: mergeNoteLWW },
  fix: { applyFirst: true, merge: mergeNoteLWW },
  bare: { applyFirst: true, merge: async (l, r) => A.merge(A.clone(l), r) },
}

/** pushNotes' core for one dirty id, parameterised by step order + merge. */
async function pushCore({ localDoc, remoteDoc, row }, mode) {
  let doc = localDoc
  if (mode.applyFirst) doc = await applyNoteFields(doc, row)
  if (remoteDoc) doc = await mode.merge(doc, remoteDoc)
  if (!mode.applyFirst) doc = await applyNoteFields(doc, row)
  return doc
}

async function run(label, mode) {
  console.log(`\n=== ${label} ===`)
  const anc = await ancestorBytes()
  const load = () => A.load(anc)

  // S1 — stale row scalar (the #24 shape). Laptop retitled at T2; the phone's
  // row is an older block edit at T1 that was never serialized. The push must
  // keep the laptop's title AND ship the phone's block edit.
  {
    const remoteDoc = await applyNoteFields(load(), base({ title: 'retitled on laptop', updatedAt: T2 }))
    const row = withBlock(base(), 'b1', '<p>one, phone</p>', T1)
    const shipped = materializeNoteRow(await pushCore({ localDoc: load(), remoteDoc, row }, mode))
    check('S1 laptop\'s newer title survives the stale-row push', shipped.title === 'retitled on laptop', `title=${shipped.title}`)
    check('S1 phone\'s own block edit still ships', htmlOf(shipped, 'b1') === '<p>one, phone</p>', `b1=${htmlOf(shipped, 'b1')}`)
    check('S1 updatedAt is the newest of both', ms(shipped.updatedAt) >= ms(T2), `updatedAt=${shipped.updatedAt}`)
  }

  // S2 — stale local BLOCK. Laptop edited b1 at T2. Phone's row changed only
  // tags at T1 and still holds b1's T0 html. Old order: the id-keyed pass put
  // the T0 html back over the laptop's edit.
  {
    const remoteDoc = await applyNoteFields(load(), withBlock(base(), 'b1', '<p>one, laptop</p>', T2))
    const row = base({ tags: ['x'], updatedAt: T1 })
    const shipped = materializeNoteRow(await pushCore({ localDoc: load(), remoteDoc, row }, mode))
    check('S2 remote\'s newer block edit survives a stale-row push', htmlOf(shipped, 'b1') === '<p>one, laptop</p>', `b1=${htmlOf(shipped, 'b1')}`)
    check('S2 phone\'s tag edit ships', JSON.stringify(shipped.tags) === '["x"]', `tags=${JSON.stringify(shipped.tags)}`)
  }

  // S3 — same-block concurrent edit, both directions, with FIXED actor ids
  // (local `aaaa`, remote `bbbb`) so a by-actor-id pick fails one direction
  // deterministically. Must resolve by time either way.
  {
    const s1 = materializeNoteRow(await pushCore({
      localDoc: A.load(anc, 'aaaa'), remoteDoc: await applyNoteFields(A.load(anc, 'bbbb'), withBlock(base(), 'b1', '<p>remote T2</p>', T2)),
      row: withBlock(base(), 'b1', '<p>local T3</p>', T3),
    }, mode))
    check('S3a local block edit at T3 beats remote at T2', htmlOf(s1, 'b1') === '<p>local T3</p>', `b1=${htmlOf(s1, 'b1')}`)
    const s2 = materializeNoteRow(await pushCore({
      localDoc: A.load(anc, 'aaaa'), remoteDoc: await applyNoteFields(A.load(anc, 'bbbb'), withBlock(base(), 'b1', '<p>remote T3</p>', T3)),
      row: withBlock(base(), 'b1', '<p>local T2</p>', T2),
    }, mode))
    check('S3b remote block edit at T3 beats local at T2', htmlOf(s2, 'b1') === '<p>remote T3</p>', `b1=${htmlOf(s2, 'b1')}`)
    check('S3 untouched b2 intact', htmlOf(s1, 'b2') === '<p>two</p>' && htmlOf(s2, 'b2') === '<p>two</p>')
  }

  // S4 — concurrent edits to DIFFERENT blocks keep both.
  {
    const remoteDoc = await applyNoteFields(load(), withBlock(base(), 'b2', '<p>two, laptop</p>', T2))
    const row = withBlock(base(), 'b1', '<p>one, phone</p>', T1)
    const shipped = materializeNoteRow(await pushCore({ localDoc: load(), remoteDoc, row }, mode))
    check('S4 both devices\' different-block edits ship', htmlOf(shipped, 'b1') === '<p>one, phone</p>' && htmlOf(shipped, 'b2') === '<p>two, laptop</p>', `b1=${htmlOf(shipped, 'b1')} b2=${htmlOf(shipped, 'b2')}`)
  }

  // S5 — retry: the manifest append failed after the first push-merge, so the
  // local doc already holds the merged state while the row is the same
  // unrefreshed T1 read. Re-push must not undo the merge.
  {
    const remoteDoc = await applyNoteFields(load(), withBlock(base({ title: 'retitled on laptop' }), 'b1', '<p>one, laptop</p>', T2))
    const row = base({ tags: ['x'], updatedAt: T1 })
    const first = await pushCore({ localDoc: load(), remoteDoc, row }, MODES.fix)
    const shipped = materializeNoteRow(await pushCore({ localDoc: A.load(A.save(first)), remoteDoc: A.load(A.save(first)), row }, mode))
    check('S5 re-push keeps the merged title', shipped.title === 'retitled on laptop', `title=${shipped.title}`)
    check('S5 re-push keeps the merged block', htmlOf(shipped, 'b1') === '<p>one, laptop</p>', `b1=${htmlOf(shipped, 'b1')}`)
  }

  // S6 — plain push, no remote change: the local block edit ships as-is.
  {
    const row = withBlock(base(), 'b1', '<p>one, phone</p>', T1)
    const shipped = materializeNoteRow(await pushCore({ localDoc: load(), remoteDoc: load(), row }, mode))
    check('S6 plain block edit ships', htmlOf(shipped, 'b1') === '<p>one, phone</p>' && shipped.updatedAt === T1, `b1=${htmlOf(shipped, 'b1')} upd=${shipped.updatedAt}`)
  }

  // S7 — legacy docs: blocks with no `_fts` yet. An unstamped block is the
  // oldest thing there is, so a real edit on either side beats it, and a
  // tombstone (delete) written now beats a legacy untouched copy.
  {
    const leg = await legacyAncestorBytes()
    const remoteDoc = await applyNoteFields(A.load(leg), withBlock(base(), 'b1', '<p>one, laptop</p>', T2))
    const rowStale = base({ tags: ['x'], updatedAt: T1 })
    const s1 = materializeNoteRow(await pushCore({ localDoc: A.load(leg), remoteDoc, row: rowStale }, mode))
    check('S7a legacy: remote\'s stamped edit beats local unstamped block', htmlOf(s1, 'b1') === '<p>one, laptop</p>', `b1=${htmlOf(s1, 'b1')}`)
    const s2 = materializeNoteRow(await pushCore({ localDoc: A.load(leg), remoteDoc: A.load(leg), row: withBlock(base(), 'b1', '<p>one, phone</p>', T1) }, mode))
    check('S7b legacy: local edit beats remote unstamped block', htmlOf(s2, 'b1') === '<p>one, phone</p>', `b1=${htmlOf(s2, 'b1')}`)
    const delRow = { ...base(), updatedAt: T1, blocks: [blk('b1', '', T1, { deleted: true }), blk('b2', '<p>two</p>', T0)] }
    const s3 = materializeNoteRow(await pushCore({ localDoc: A.load(leg), remoteDoc: A.load(leg), row: delRow }, mode))
    check('S7c legacy: a delete written now sticks', s3.blocks.find(b => b.id === 'b1')?.deleted === true, `b1=${JSON.stringify(s3.blocks.find(b => b.id === 'b1'))}`)
  }
}

await run('A) OLD (merge, then re-apply row) — expected FAIL', MODES.old)
const oldFailures = failures
failures = 0
await run('B) FIX (apply row, then mergeNoteLWW with block stamps) — expected PASS', MODES.fix)
const fixFailures = failures
failures = 0
await run('C) apply row, then BARE Automerge.merge (no block LWW) — expected FAIL on S3', MODES.bare)
const bareFailures = failures

console.log('\n=== SUMMARY ===')
console.log(`  old  (merge-then-apply)          failures: ${oldFailures}  (bug reproduced if > 0)`)
console.log(`  fix  (apply-then-merge + stamps) failures: ${fixFailures}  (fix correct if 0)`)
console.log(`  bare (apply-then-bare-merge)     failures: ${bareFailures}  (block stamps needed if > 0)`)
if (oldFailures > 0 && fixFailures === 0 && bareFailures > 0) {
  console.log('  RESULT: ✓ bug reproduced AND apply-then-merge + block stamps proven')
  process.exit(0)
}
console.log('  RESULT: ✗ unexpected — investigate')
process.exit(1)
