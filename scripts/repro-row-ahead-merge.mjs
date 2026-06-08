/**
 * Repro for the SINGLE-DEVICE "task I was editing reverted on me" bug
 * (status done -> not done, then typed feedback deleted). NOT a cross-device
 * race — captured live with the phone OFF (synclog 7743d2fd, 2026-06-07).
 *
 * Root cause — the row/doc write skew:
 *   A task is stored in IDB as TWO views of one record:
 *     • the ROW   (plain JSON fields: status, feedback, updatedAt …) — owned by
 *       updateTask, the UI write path. Fast, no Automerge/WASM.
 *     • the DOC   (`_doc` Automerge bytes) — owned by pushTasks, which
 *       re-serializes the row into the CRDT via applyTaskFields and stamps `_fts`.
 *   updateTask writes ONLY the row (+ marks dirty); the doc is re-serialized
 *   LATER by pushTasks. So there is a window where the ROW is NEWER than the DOC.
 *
 *   A force-poll fires right after every push. If its merge lands inside that
 *   window, mergeTaskDocs loads the STALE doc bytes (old status, old `_fts`),
 *   the per-field LWW correctly prefers the stale doc over the equally-stale (or
 *   older) remote — but BOTH are behind the live ROW. materializeTaskRow then
 *   produces a row older than the user's, and putTaskWithDoc OVERWRITES the live
 *   row. Status reverts; updatedAt runs backwards (the `updBackwards:true` signal
 *   on the `lww` path that the cross-device fix promised could never happen).
 *
 *   The existing dirty-reapply guard (sync.js: `if (l && dirtyTasks[id])`) was
 *   meant to cover this, but pushTasks calls clearDirty() before the racing
 *   poll-merge reads the dirty set, so the guard misses. (0 "preserved dirty"
 *   log entries despite the row being newer than the doc.)
 *
 * The INVARIANT this encodes:
 *   A background merge must NEVER materialize a task row older than the live
 *   local row. When the live row's updatedAt is newer than the merged doc's,
 *   the row is authoritative for its owned fields and must be re-folded onto
 *   the merge result (and re-stamped) so it survives and gets pushed.
 *
 * Checks:
 *   (A) CURRENT reconcile (no row authority) -> expected to FAIL
 *   (B) REAL fix: reconcileLiveRow() from src/automergeDoc.js -> expected PASS
 *
 * Run: node scripts/repro-row-ahead-merge.mjs
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
  reconcileLiveRow,
} = await import('../src/services/automergeDoc.js')

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!pass) failures++
}

const C0 = '2026-06-07T09:00:00.000Z' // createdAt, before any edit

/**
 * Build the exact pre-merge state from the live regression, faithfully:
 *  - doc bytes reflect the LAST PUSHED state (status:active) — the doc pushTasks
 *    serialized when the task was created/last synced.
 *  - the live ROW carries a NEWER, NOT-YET-SERIALIZED edit (status:done).
 *  - the remote .bin the poll fetched is the same already-pushed `active` doc
 *    (Drive returned our own earlier upsert / a stale read).
 * This is the row-ahead-of-doc window.
 */
async function makeState({ docStatus, docUpd, remoteStatus, remoteUpd, rowStatus, rowUpd, rowExtra = {} }) {
  // Common ancestor so local & remote share Automerge history (the `lww` path).
  const baseDoc = await createDoc('task', { id: 'tX', title: 'graph task', status: 'active', createdAt: C0, updatedAt: docUpd })
  const baseBytes = A.save(baseDoc)

  // Local doc bytes = what's in IDB `_doc` right now (last serialized push).
  const localDoc = A.load(baseBytes)
  const localBytes = A.save(await applyTaskFields(localDoc, { id: 'tX', title: 'graph task', status: docStatus, createdAt: C0, updatedAt: docUpd }))

  // Remote .bin fetched by the poll — diverge from the same base.
  const remoteDoc = A.load(baseBytes)
  const remoteBytes = A.save(await applyTaskFields(remoteDoc, { id: 'tX', title: 'graph task', status: remoteStatus, createdAt: C0, updatedAt: remoteUpd }))

  // The LIVE ROW (IndexedDB JSON) — what updateTask wrote, ahead of the doc.
  const liveRow = { id: 'tX', title: 'graph task', status: rowStatus, createdAt: C0, updatedAt: rowUpd, ...rowExtra }

  return { localBytes, remoteBytes, liveRow }
}

// Faithful model of mergeTaskDocs' core (shared ancestry -> mergeTaskLWW),
// parameterised by whether it applies the row-authority reconcile.
async function mergeAndMaterialize({ localBytes, remoteBytes, liveRow }, { withReconcile }) {
  const localDoc = A.load(localBytes)
  const remoteDoc = A.load(remoteBytes)
  let mergedDoc = await mergeTaskLWW(localDoc, remoteDoc)
  if (withReconcile) mergedDoc = await reconcileLiveRow(mergedDoc, liveRow, applyTaskFields, materializeTaskRow)
  return materializeTaskRow(mergedDoc)
}

async function run(label, withReconcile) {
  console.log(`\n=== ${label} ===`)

  // Scenario 1 — the exact live case: row says done (23:07:59), doc+remote are
  // the older pushed `active` (≈23:07:54). The merge must not revert to active.
  {
    const st = await makeState({
      docStatus: 'active',  docUpd: '2026-06-07T23:07:54.292Z',
      remoteStatus: 'active', remoteUpd: '2026-06-07T23:07:54.292Z',
      rowStatus: 'done',    rowUpd: '2026-06-07T23:07:59.251Z',
    })
    const row = await mergeAndMaterialize(st, { withReconcile })
    check('S1 live "done" not reverted to active', row.status === 'done', `got=${row.status}`)
    check('S1 updatedAt not older than live row', ms(row.updatedAt) >= ms(st.liveRow.updatedAt), `merged=${row.updatedAt} live=${st.liveRow.updatedAt}`)
  }

  // Scenario 2 — typed feedback into a freshly-done task; doc still pre-feedback.
  // Both the status AND the feedback live only on the row; neither may be lost.
  {
    const st = await makeState({
      docStatus: 'done',  docUpd: '2026-06-07T23:08:14.042Z',
      remoteStatus: 'done', remoteUpd: '2026-06-07T23:08:14.042Z',
      rowStatus: 'done',  rowUpd: '2026-06-07T23:08:15.175Z',
      rowExtra: { feedback: 'my actual feedback text' },
    })
    const row = await mergeAndMaterialize(st, { withReconcile })
    check('S2 typed feedback survived', row.feedback === 'my actual feedback text', `got=${JSON.stringify(row.feedback)}`)
    check('S2 updatedAt not backwards', ms(row.updatedAt) >= ms(st.liveRow.updatedAt), `merged=${row.updatedAt} live=${st.liveRow.updatedAt}`)
  }

  // Scenario 3 — doc is AHEAD of the row (normal: push already serialized a
  // newer state, the row is the stale read). Reconcile must NOT drag it back.
  {
    const st = await makeState({
      docStatus: 'reviewed', docUpd: '2026-06-07T23:10:00.000Z',
      remoteStatus: 'reviewed', remoteUpd: '2026-06-07T23:10:00.000Z',
      rowStatus: 'done',     rowUpd: '2026-06-07T23:09:00.000Z',
    })
    const row = await mergeAndMaterialize(st, { withReconcile })
    check('S3 newer doc state kept (row not forced back)', row.status === 'reviewed', `got=${row.status}`)
  }
}

await run('A) CURRENT (merge only, no row authority) — expected FAIL', false)
const currentFailures = failures

failures = 0
await run('B) FIX (reconcileLiveRow row authority) — expected PASS', true)
const fixedFailures = failures

// --- Notes: same row/doc skew. reconcileLiveRow must re-assert a newer note row
// WITHOUT clobbering a freshly-merged remote body block (blocks are id-keyed
// reconciled by applyNoteFields, never wholesale-overwritten). ----------------
failures = 0
console.log('\n=== C) NOTES row authority (body must not be clobbered) — expected PASS ===')
{
  const block = (id, html, order, at) => ({ id, html, deleted: false, order, updatedAt: at })
  // Base note: title "orig", one body block b1.
  const base = A.save(await createDoc('note', {
    id: 'nX', title: 'orig', createdAt: C0, updatedAt: '2026-06-07T10:00:00.000Z',
    blocks: [block('b1', '<p>body</p>', 'a0', C0)],
  }))
  // Local doc bytes (last pushed) still title "orig".
  const localBytes = base
  // Remote (poll-fetched): another device APPENDED a new block b2 (newer).
  const remoteBytes = A.save(await applyNoteFields(A.load(base), {
    id: 'nX', title: 'orig', createdAt: C0, updatedAt: '2026-06-07T10:05:00.000Z',
    blocks: [block('b1', '<p>body</p>', 'a0', C0), block('b2', '<p>remote add</p>', 'a1', '2026-06-07T10:05:00.000Z')],
  }))
  // Live ROW: user just RETITLED locally (newer than doc), body unchanged. Row
  // still only knows b1 (its editor snapshot predates the remote b2).
  const liveRow = {
    id: 'nX', title: 'my new title', createdAt: C0, updatedAt: '2026-06-07T10:06:00.000Z',
    blocks: [block('b1', '<p>body</p>', 'a0', C0)],
  }
  let merged = await mergeNoteLWW(A.load(localBytes), A.load(remoteBytes))
  merged = await reconcileLiveRow(merged, liveRow, applyNoteFields, materializeNoteRow)
  const row = materializeNoteRow(merged)
  const live = (row.blocks || []).filter(b => !b.deleted).map(b => b.id).sort()
  check('C title re-folded from newer row', row.title === 'my new title', `title=${row.title}`)
  check('C remote-added block b2 NOT clobbered', live.includes('b2'), `blocks=${JSON.stringify(live)}`)
  check('C own block b1 still present', live.includes('b1'), `blocks=${JSON.stringify(live)}`)
}
const noteFailures = failures

console.log('\n=== SUMMARY ===')
console.log(`  current (no reconcile) failures: ${currentFailures}  (bug reproduced if > 0)`)
console.log(`  fixed task (reconcileLiveRow):   ${fixedFailures}  (fix correct if 0)`)
console.log(`  notes (body-safe re-fold):       ${noteFailures}  (fix correct if 0)`)
if (currentFailures > 0 && fixedFailures === 0 && noteFailures === 0) {
  console.log('  RESULT: ✓ bug reproduced AND row-authority fix proven for tasks + notes')
  process.exit(0)
} else {
  console.log('  RESULT: ✗ unexpected — investigate')
  process.exit(1)
}
