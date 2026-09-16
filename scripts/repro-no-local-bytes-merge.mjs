/**
 * Repro for #29 — the NO-LOCAL-BYTES branch of the pull merge.
 *
 * The state: this device holds a task/note ROW with no `_doc` bytes, while a
 * `.bin` for the same id already exists on Drive. `mergeTaskDocs` /
 * `mergeNoteDocs` used to answer that with a bare
 *
 *     mergedDoc = await applyTaskFields(remoteDoc, localRow)
 *
 * — the whole row written over the remote doc at the ROW's clock, with no
 * merge at all. `applyTaskFields` is a DELTA helper: it stamps a field only
 * when the value it writes differs from what the doc already holds. Against
 * our own bytes that is exactly right (a difference means the row changed it).
 * Against the REMOTE's doc there is no local ancestry, so every field the row
 * merely disagrees with — because the other device changed it and we never
 * pulled — reads as "the row changed this", is stamped at the row's clock and
 * overwrites a value that may be far newer. Same clobber shape as #24/#25/#27,
 * one branch over.
 *
 * Reachable, not theoretical — two ways, both proven by reading:
 *   1. THE SECOND DEVICE TO MIGRATE. tasksAutomergeMigration /
 *      notesAutomergeMigration seed the local row's `_doc` only inside
 *      `if (!hasBin)` — i.e. only for ids this device converted itself. The
 *      device that migrates SECOND finds every `.bin` already on Drive, seeds
 *      nothing, sets its migration flag and carries on with every Phase-B row
 *      holding no bytes. Each of those rows meets its remote `.bin` in this
 *      branch on the next poll that touches it, however stale the row is.
 *   2. A TOMBSTONE FOR AN ID THIS DEVICE NEVER HELD. The manifest-delete arm
 *      of both merges writes `{ id, deleted: true, deletedAt, updatedAt }`
 *      through putTasks/putNotes, which only preserves `_doc` bytes if the
 *      record already existed. Restore-from-trash on the other device then
 *      uploads a fresh `.bin` and this branch meets the bare tombstone.
 *
 * THE FIX (both entity types): the remote is still the only base there is —
 * adopt its root, fold the row into a COPY of it, and LWW-merge that copy back
 * against the unmodified remote. The fold becomes a proposal stamped at the
 * row's clock; the merge decides it per field against the remote's `_fts`, via
 * the same mergeTaskLWW / mergeNoteLWW the shared-ancestry path has used since
 * #24. No new merge rule, no new helper.
 *
 *     mergedDoc = await mergeTaskLWW(await applyTaskFields(remoteDoc, l), remoteDoc)
 *
 * WHAT IT DELIBERATELY DOES NOT PROMISE (N4/M4 below, pinned not asserted): a
 * row carries ONE clock for all its fields and, with no bytes, no ancestry to
 * say which of them it actually changed. So a field the row merely disagrees
 * with still wins whenever the row's clock is the newer one — the fix bounds
 * the clobber by time, it cannot attribute it. Blocks are exempt: they carry
 * their own per-block clock, so a stale block loses even inside a newer row.
 *
 * Checks:
 *   (A) TASKS old — applyTaskFields(remoteDoc, row), full stop     -> N1/N2/N3 expected FAIL
 *   (B) TASKS new — fold onto the remote's root, then mergeTaskLWW -> expected PASS
 *   (C) NOTES old — applyNoteFields(remoteDoc, row), full stop     -> M1/M2 expected FAIL
 *   (D) NOTES new — fold onto the remote's root, then mergeNoteLWW -> expected PASS
 *
 * Run: node scripts/repro-no-local-bytes-merge.mjs
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window

const A = await import('@automerge/automerge')
const ms = (iso) => new Date(iso).getTime()

const {
  createDoc, applyTaskFields, materializeTaskRow, mergeTaskLWW,
  applyNoteFields, materializeNoteRow, mergeNoteLWW,
} = await import('../src/services/automergeDoc.js')

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!pass) failures++
}

// Four clocks, in order. R* are this device's row, X* the other device's .bin.
const C0 = '2026-09-01T09:00:00.000Z' // createdAt / the pre-cutover state
const R1 = '2026-09-14T10:00:00.000Z' // this row's clock when it is the stale one
const X1 = '2026-09-14T11:00:00.000Z' // the other device's edit — newer than R1
const R2 = '2026-09-14T11:30:00.000Z' // this device's own local edit
const X2 = '2026-09-14T12:00:00.000Z' // the other device's edit — newer than R2

/**
 * The two orders, as `mergeTaskDocs`' no-local-bytes branch runs them. There is
 * deliberately no local-bytes case in this file: it is only about the branch
 * where `localBytes` is null and a row exists.
 */
async function taskMerge(remoteBytes, liveRow, { foldThenMerge }) {
  const remoteDoc = A.load(remoteBytes)
  const folded = await applyTaskFields(remoteDoc, liveRow)
  const mergedDoc = foldThenMerge ? await mergeTaskLWW(folded, remoteDoc) : folded
  return materializeTaskRow(mergedDoc)
}

async function noteMerge(remoteBytes, liveRow, { foldThenMerge }) {
  const remoteDoc = A.load(remoteBytes)
  const folded = await applyNoteFields(remoteDoc, liveRow)
  const mergedDoc = foldThenMerge ? await mergeNoteLWW(folded, remoteDoc) : folded
  return materializeNoteRow(mergedDoc)
}

/**
 * The remote `.bin` as the OTHER device left it: a doc created at the Automerge
 * cutover from the Phase-B JSON (`createDoc`, so nothing is stamped yet), then
 * edited there — which stamps exactly the fields that edit changed, and only
 * those. Everything else keeps the shared `createdAt` floor, which is what
 * makes a row's genuine edit able to win a field the remote never touched.
 */
async function remoteTask(edit) {
  const seed = { id: 'tX', title: 'ship the thing', status: 'active', explanation: 'orig', order: 'a0', createdAt: C0, updatedAt: C0 }
  const doc = await createDoc('task', seed)
  return A.save(await applyTaskFields(A.load(A.save(doc)), { ...seed, ...edit }))
}

async function runTasks(label, foldThenMerge) {
  console.log(`\n=== ${label} ===`)

  // N1 — the migration case, in full. This device never converted the task (the
  // other one did), so its row is the Phase-B row it last synced, at R1: status
  // active, explanation "orig". The other device reviewed it at X1 and rewrote
  // the explanation. Nothing on this row is newer, so the remote must survive
  // whole. The bare fold wrote the entire stale row over it.
  {
    const remoteBytes = await remoteTask({ status: 'reviewed', explanation: 'rewritten on the laptop', updatedAt: X1 })
    const liveRow = { id: 'tX', title: 'ship the thing', status: 'active', explanation: 'orig', order: 'a0', createdAt: C0, updatedAt: R1 }
    const row = await taskMerge(remoteBytes, liveRow, { foldThenMerge })
    check('N1 remote status (@X1) NOT clobbered by the older row', row.status === 'reviewed', `status=${row.status}`)
    check('N1 remote explanation (@X1) NOT clobbered by the older row', row.explanation === 'rewritten on the laptop', `explanation=${JSON.stringify(row.explanation)}`)
    check('N1 updatedAt not older than the remote', ms(row.updatedAt) >= ms(X1), `merged=${row.updatedAt}`)
  }

  // N2 — the task's requirement in one scenario: the remote field must survive
  // AND the row's genuinely newer field must survive. This device (sync paused,
  // so nothing ever serialized bytes) marked the task done at R2; the other
  // device rewrote the explanation afterwards, at X2. The row's `status` beats
  // the remote's createdAt floor for that field; the remote's `explanation`
  // beats the row's clock. The bare fold got `status` right by accident and
  // wrote the row's stale "orig" explanation back over X2.
  {
    const remoteBytes = await remoteTask({ explanation: 'rewritten on the laptop', updatedAt: X2 })
    const liveRow = { id: 'tX', title: 'ship the thing', status: 'done', explanation: 'orig', order: 'a0', createdAt: C0, updatedAt: R2 }
    const row = await taskMerge(remoteBytes, liveRow, { foldThenMerge })
    check("N2 row's own edit (status done @R2) kept", row.status === 'done', `status=${row.status}`)
    check('N2 remote explanation (@X2) NOT clobbered by the stale row field', row.explanation === 'rewritten on the laptop', `explanation=${JSON.stringify(row.explanation)}`)
    check('N2 updatedAt not older than the live row', ms(row.updatedAt) >= ms(R2), `merged=${row.updatedAt} live=${R2}`)
  }

  // N3 — the tombstone case. This device never held the task, so the
  // manifest-delete arm wrote it a BARE tombstone row at R1 and no bytes. The
  // other device then restored the task from Trash at X1 and pushed a fresh
  // `.bin`. The restore is newer, so it must win: the task comes back.
  //
  // Note what this scenario does NOT claim. A bare tombstone names four fields,
  // and applyTaskFields removes from the doc every key the source omits — so
  // `title` is deleted at R1 and survives only if the remote stamped it AFTER
  // R1, which a restore does not (restoreTrashedTask writes the row back
  // unchanged apart from `deleted`, so applyTaskFields stamps only `deleted`).
  // The row-is-a-complete-materialization assumption that breaks there is
  // pre-existing and shared with the local-bytes path; the second check pins
  // today's behaviour rather than asserting it is right.
  {
    const remoteBytes = await remoteTask({ deleted: false, deletedAt: null, updatedAt: X1 })
    const liveRow = { id: 'tX', deleted: true, deletedAt: R1, updatedAt: R1 }
    const row = await taskMerge(remoteBytes, liveRow, { foldThenMerge })
    check("N3 the other device's restore (@X1) beats the older tombstone (@R1)", row.deleted !== true, `deleted=${JSON.stringify(row.deleted)}`)
    check('N3 [PINNED, not a claim] a bare tombstone still drops the unstamped title', row.title === undefined, `title=${JSON.stringify(row.title)}`)
  }

  // N4 — the residual, pinned under BOTH orders so it can never be mistaken for
  // something the fix settled. Here the row's clock (R2) is the newer one and
  // the remote's explanation edit (X1) is older, so the row's stale "orig" wins
  // — even though this device never touched the explanation. One clock per row
  // and no ancestry is exactly as much as this branch knows; bounding the
  // clobber by time is all the fix can do. Filed as its own issue.
  {
    const remoteBytes = await remoteTask({ explanation: 'rewritten on the laptop', updatedAt: X1 })
    const liveRow = { id: 'tX', title: 'ship the thing', status: 'done', explanation: 'orig', order: 'a0', createdAt: C0, updatedAt: R2 }
    const row = await taskMerge(remoteBytes, liveRow, { foldThenMerge })
    check('N4 [PINNED, not a claim] a newer row still re-asserts a field it never changed', row.explanation === 'orig', `explanation=${JSON.stringify(row.explanation)}`)
  }
}

// --- Notes: same branch, same fix, and the same double clobber #27 found on
// the local-bytes path — a stale scalar AND a stale block. ------------------

const blk = (id, html, order, at) => ({ id, html, deleted: false, order, updatedAt: at })

/** The remote note `.bin` as the other device left it: cutover, then an edit. */
async function remoteNote(edit) {
  const seed = {
    id: 'nX', title: 'meeting notes', tags: [], createdAt: C0, updatedAt: C0,
    blocks: [blk('b1', '<p>one</p>', 'a0', C0), blk('b2', '<p>two</p>', 'a1', C0)],
  }
  const doc = await createDoc('note', seed)
  return A.save(await applyNoteFields(A.load(A.save(doc)), { ...seed, ...edit }))
}

async function runNotes(label, foldThenMerge) {
  console.log(`\n=== ${label} ===`)

  // M1 — the migration case for a note: this device's row is the Phase-B one at
  // R1, the other device retitled the note AND rewrote block b1 at X1. Nothing
  // on this row is newer, so both remote edits must survive. The bare fold lost
  // both — the scalar and the block, the #27 shape one branch over.
  {
    const remoteBytes = await remoteNote({
      title: 'meeting notes — rewritten', updatedAt: X1,
      blocks: [blk('b1', '<p>one, rewritten on the laptop</p>', 'a0', X1), blk('b2', '<p>two</p>', 'a1', C0)],
    })
    const liveRow = {
      id: 'nX', title: 'meeting notes', tags: [], createdAt: C0, updatedAt: R1,
      blocks: [blk('b1', '<p>one</p>', 'a0', C0), blk('b2', '<p>two</p>', 'a1', C0)],
    }
    const row = await noteMerge(remoteBytes, liveRow, { foldThenMerge })
    const b1 = (row.blocks || []).find(b => b.id === 'b1')
    check('M1 remote title (@X1) NOT clobbered by the older row', row.title === 'meeting notes — rewritten', `title=${JSON.stringify(row.title)}`)
    check('M1 remote block edit (@X1) NOT clobbered by the older row block', b1?.html === '<p>one, rewritten on the laptop</p>', `html=${JSON.stringify(b1?.html)}`)
  }

  // M2 — the note's version of N2, with four things to keep at once. This
  // device edited block b2 and appended b3 at R2; the other device retitled and
  // rewrote b1 afterwards, at X2. All four must survive: the remote's title and
  // b1 by their newer stamps, the row's b2 by its own block clock, and b3
  // because the remote has never seen it (no merge rule decides it — it is
  // simply appended, which is the whole point of the append-only block list).
  {
    const remoteBytes = await remoteNote({
      title: 'meeting notes — rewritten', updatedAt: X2,
      blocks: [blk('b1', '<p>one, rewritten on the laptop</p>', 'a0', X2), blk('b2', '<p>two</p>', 'a1', C0)],
    })
    const liveRow = {
      id: 'nX', title: 'meeting notes', tags: [], createdAt: C0, updatedAt: R2,
      blocks: [
        blk('b1', '<p>one</p>', 'a0', C0),
        blk('b2', '<p>two, edited on the phone</p>', 'a1', R2),
        blk('b3', '<p>three, added on the phone</p>', 'a2', R2),
      ],
    }
    const row = await noteMerge(remoteBytes, liveRow, { foldThenMerge })
    const by = (id) => (row.blocks || []).find(b => b.id === id)
    check('M2 remote title (@X2) NOT clobbered by the stale row field', row.title === 'meeting notes — rewritten', `title=${JSON.stringify(row.title)}`)
    check('M2 remote block b1 (@X2) NOT clobbered by the stale row block', by('b1')?.html === '<p>one, rewritten on the laptop</p>', `html=${JSON.stringify(by('b1')?.html)}`)
    check("M2 row's own block edit b2 (@R2) kept", by('b2')?.html === '<p>two, edited on the phone</p>', `html=${JSON.stringify(by('b2')?.html)}`)
    check("M2 row's brand-new block b3 kept", by('b3')?.html === '<p>three, added on the phone</p>', `html=${JSON.stringify(by('b3')?.html)}`)
    check('M2 updatedAt not older than the live row', ms(row.updatedAt) >= ms(R2), `merged=${row.updatedAt} live=${R2}`)
  }

  // M3 — the guard the fix must not break: with no local bytes the remote is
  // still adopted whole. A row that knows about neither of the remote's blocks
  // must not erase them (the disjoint-root content-loss this branch exists to
  // avoid — never createDoc()+merge here), and `_fts` must never reach the row.
  {
    const remoteBytes = await remoteNote({ updatedAt: X1 })
    const liveRow = { id: 'nX', title: 'meeting notes', tags: [], createdAt: C0, updatedAt: R1, blocks: [] }
    const row = await noteMerge(remoteBytes, liveRow, { foldThenMerge })
    const live = (row.blocks || []).filter(b => !b.deleted).map(b => b.id).sort()
    check("M3 the remote's blocks survive a row that lists none", live.join(',') === 'b1,b2', `blocks=${JSON.stringify(live)}`)
    check('M3 `_fts` never leaks into the row', !('_fts' in row) && (row.blocks || []).every(b => !('_fts' in b)), `keys=${Object.keys(row).join(',')}`)
  }

  // M4 — the note half of the residual N4 pins, and the line between them: a
  // newer row re-asserts a SCALAR it never changed (one clock for the whole
  // row), but NOT a block, because every block carries its own clock. Pinned
  // under both orders; the scalar half is the filed issue.
  {
    const remoteBytes = await remoteNote({
      title: 'meeting notes — rewritten', updatedAt: X1,
      blocks: [blk('b1', '<p>one, rewritten on the laptop</p>', 'a0', X1), blk('b2', '<p>two</p>', 'a1', C0)],
    })
    const liveRow = {
      id: 'nX', title: 'meeting notes', tags: [], createdAt: C0, updatedAt: R2,
      blocks: [blk('b1', '<p>one</p>', 'a0', C0), blk('b2', '<p>two, edited on the phone</p>', 'a1', R2)],
    }
    const row = await noteMerge(remoteBytes, liveRow, { foldThenMerge })
    const by = (id) => (row.blocks || []).find(b => b.id === id)
    check('M4 [PINNED, not a claim] a newer row still re-asserts a scalar it never changed', row.title === 'meeting notes', `title=${JSON.stringify(row.title)}`)
    check("M4 a stale BLOCK inside that same newer row does NOT win — it has its own clock", by('b1')?.html === '<p>one, rewritten on the laptop</p>', `html=${JSON.stringify(by('b1')?.html)}`)
  }
}

failures = 0
await runTasks('A) TASKS old — applyTaskFields(remoteDoc, row), full stop — expected FAIL', false)
const taskOld = failures

failures = 0
await runTasks("B) TASKS new — fold onto the remote's root, then mergeTaskLWW — expected PASS", true)
const taskNew = failures

failures = 0
await runNotes('C) NOTES old — applyNoteFields(remoteDoc, row), full stop — expected FAIL', false)
const noteOld = failures

failures = 0
await runNotes("D) NOTES new — fold onto the remote's root, then mergeNoteLWW — expected PASS", true)
const noteNew = failures

console.log('\n=== SUMMARY ===')
console.log(`  tasks fold-only (the old branch) failures: ${taskOld}  (bug reproduced if > 0)`)
console.log(`  tasks fold-then-merge failures:            ${taskNew}  (fix correct if 0)`)
console.log(`  notes fold-only (the old branch) failures: ${noteOld}  (bug reproduced if > 0)`)
console.log(`  notes fold-then-merge failures:            ${noteNew}  (fix correct if 0)`)
if (taskOld > 0 && taskNew === 0 && noteOld > 0 && noteNew === 0) {
  console.log('  RESULT: ✓ #29 reproduced for tasks AND notes, and fold-then-merge proven for both')
  process.exit(0)
} else {
  console.log('  RESULT: ✗ unexpected — investigate')
  process.exit(1)
}
