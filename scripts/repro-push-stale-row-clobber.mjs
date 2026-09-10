/**
 * Repro for the CROSS-DEVICE "reviewed on the laptop, still a todo on the
 * phone" bug (yajna#24, synclogs 74cee0eb + 7743d2fd, manifest seq 11803-11807,
 * 2026-09-09/10).
 *
 * What happened, from the manifest:
 *   07:53Z phone reorders three tasks (row.updatedAt 07:53:09.280, order 6/7).
 *   07:54Z phone's pushTasks starts, Brave freezes the tab mid-loop.
 *   09:14Z laptop marks the same two tasks `reviewed` (updatedAt 09:14:09/11).
 *   17:42Z phone thaws; the frozen loop continues: reads the laptop's .bin,
 *          LWW-merges it (status=reviewed wins, 09:14 > 07:53) — and THEN
 *          `applyTaskFields(doc, fresh)` re-applies the 07:53 row on top,
 *          re-stamping status=active at 07:53. Ships it. Drive now says active.
 *   The phone's forced poll fetches its own bytes back — nothing to change.
 *   The laptop keeps `reviewed` only because its LOCAL stamps beat the clobber.
 *
 * Root cause — merge-then-apply in pushTasks:
 *   Per-field wall-clock LWW picks the newer value per field, then the very
 *   next line overwrites every field the local ROW disagrees with, at the
 *   row's (older) clock. The merge is undone whenever the remote moved on.
 *
 * The INVARIANT this encodes:
 *   Row → doc → merge. The row is serialized into the LOCAL doc first, at the
 *   row's own clock (stampLWW touches only the fields the row changed), and the
 *   result is LWW-merged with the remote. A field the other device wrote later
 *   keeps winning; the row's own edits (order) still ship.
 *
 * Checks:
 *   (A) CURRENT order (merge, then apply row)  -> expected FAIL
 *   (B) FIX order     (apply row, then merge)  -> expected PASS
 *
 * Run: node scripts/repro-push-stale-row-clobber.mjs
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window

const A = await import('@automerge/automerge')
const ms = (iso) => new Date(iso).getTime()

const { createDoc, applyTaskFields, materializeTaskRow, mergeTaskLWW } =
  await import('../src/services/automergeDoc.js')

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!pass) failures++
}

const C0 = '2026-09-08T11:44:14.390Z' // createdAt (laptop, seq 11747)
const T_PUSHED = '2026-09-08T16:41:38.672Z' // last state both devices had pushed
const T_REORDER = '2026-09-09T07:53:09.280Z' // phone reorder (row only, doc not yet serialized)
const T_REVIEW = '2026-09-09T09:14:09.794Z' // laptop marks reviewed

const base = (over = {}) => ({
  id: '8dd8f6e3', title: 'פוסט בלינקדין!', status: 'active', order: 287,
  createdAt: C0, updatedAt: T_PUSHED, ...over,
})

/** Shared ancestor: the doc as both devices last pushed it. */
async function ancestorBytes() {
  return A.save(await createDoc('task', base()))
}

/**
 * The phone's pushTasks core for one dirty id, parameterised by the order of
 * the two steps. `localBytes` = phone's IDB `_doc`, `row` = phone's live row,
 * `remoteBytes` = the .bin read from Drive right before the merge.
 */
async function pushCore({ localBytes, remoteBytes, row }, { applyFirst }) {
  let doc = A.load(localBytes)
  const remoteDoc = remoteBytes ? A.load(remoteBytes) : null
  if (applyFirst) doc = await applyTaskFields(doc, row)
  if (remoteDoc) doc = await mergeTaskLWW(doc, remoteDoc)
  if (!applyFirst) doc = await applyTaskFields(doc, row)
  return doc
}

async function run(label, applyFirst) {
  console.log(`\n=== ${label} ===`)
  const anc = await ancestorBytes()

  // Scenario 1 — the live case. Phone: doc = last push, row = reorder (07:53,
  // order 6, still active). Laptop's .bin on Drive: reviewed at 09:14.
  {
    const remoteBytes = A.save(await applyTaskFields(A.load(anc), base({ status: 'reviewed', reviewedDate: '2026-09-09', updatedAt: T_REVIEW })))
    const row = base({ order: 6, updatedAt: T_REORDER })
    const shipped = materializeTaskRow(await pushCore({ localBytes: anc, remoteBytes, row }, { applyFirst }))
    check('S1 laptop\'s newer `reviewed` survives the phone push', shipped.status === 'reviewed', `shipped status=${shipped.status}`)
    check('S1 phone\'s reorder still ships (order 6)', shipped.order === 6, `shipped order=${shipped.order}`)
    check('S1 updatedAt is the newest of both', ms(shipped.updatedAt) >= ms(T_REVIEW), `shipped updatedAt=${shipped.updatedAt}`)

    // What a THIRD reader materializes from Drive, with nothing local to save it.
    const fresh = materializeTaskRow(await pushCore({ localBytes: anc, remoteBytes, row }, { applyFirst }))
    check('S1 a device adopting Drive sees reviewed', fresh.status === 'reviewed', `status=${fresh.status}`)
  }

  // Scenario 2 — retry: the append failed after the first push-merge, so the
  // local doc ALREADY holds the merged remote state while the row is still the
  // unrefreshed 07:53 read. The re-push must not clobber either.
  {
    const remoteBytes = A.save(await applyTaskFields(A.load(anc), base({ status: 'reviewed', updatedAt: T_REVIEW })))
    const row = base({ order: 6, updatedAt: T_REORDER })
    const firstDoc = await pushCore({ localBytes: anc, remoteBytes, row }, { applyFirst: true })
    const localBytes = A.save(firstDoc)
    const shipped = materializeTaskRow(await pushCore({ localBytes, remoteBytes: A.save(firstDoc), row }, { applyFirst }))
    check('S2 re-push over an already-merged doc keeps reviewed', shipped.status === 'reviewed', `status=${shipped.status}`)
    check('S2 re-push keeps order 6', shipped.order === 6, `order=${shipped.order}`)
  }

  // Scenario 3 — the 7db2bf3 case must still hold: the row is NEWER than the
  // remote (offline edit while the other device changed a different field).
  {
    const remoteBytes = A.save(await applyTaskFields(A.load(anc), base({ title: 'retitled on laptop', updatedAt: '2026-09-09T08:00:00.000Z' })))
    const row = base({ status: 'done', updatedAt: '2026-09-09T08:30:00.000Z' })
    const shipped = materializeTaskRow(await pushCore({ localBytes: anc, remoteBytes, row }, { applyFirst }))
    check('S3 newer offline row edit (done) ships', shipped.status === 'done', `status=${shipped.status}`)
    check('S3 remote\'s concurrent retitle kept', shipped.title === 'retitled on laptop', `title=${shipped.title}`)
  }

  // Scenario 4 — no remote change at all: plain push of a reorder.
  {
    const row = base({ order: 6, updatedAt: T_REORDER })
    const shipped = materializeTaskRow(await pushCore({ localBytes: anc, remoteBytes: anc, row }, { applyFirst }))
    check('S4 plain reorder push ships order 6', shipped.order === 6 && shipped.updatedAt === T_REORDER, `order=${shipped.order} upd=${shipped.updatedAt}`)
  }
}

await run('A) CURRENT (merge, then re-apply row) — expected FAIL', false)
const currentFailures = failures
failures = 0
await run('B) FIX (apply row, then merge) — expected PASS', true)
const fixedFailures = failures

console.log('\n=== SUMMARY ===')
console.log(`  current (merge-then-apply) failures: ${currentFailures}  (bug reproduced if > 0)`)
console.log(`  fixed   (apply-then-merge) failures: ${fixedFailures}  (fix correct if 0)`)
if (currentFailures > 0 && fixedFailures === 0) {
  console.log('  RESULT: ✓ bug reproduced AND apply-then-merge proven')
  process.exit(0)
}
console.log('  RESULT: ✗ unexpected — investigate')
process.exit(1)
