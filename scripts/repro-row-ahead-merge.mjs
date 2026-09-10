/**
 * Repro for the row-ahead-of-doc window in the task PULL merge (mergeTaskDocs)
 * — two bugs, one root, one ordering fix.
 *
 * Root — the row/doc write skew:
 *   A task is stored in IDB as TWO views of one record:
 *     • the ROW   (plain JSON fields: status, feedback, updatedAt …) — owned by
 *       updateTask, the UI write path. Fast, no Automerge/WASM.
 *     • the DOC   (`_doc` Automerge bytes) — owned by pushTasks, which
 *       re-serializes the row into the CRDT via applyTaskFields and stamps `_fts`.
 *   updateTask writes ONLY the row (+ marks dirty); the doc is re-serialized
 *   LATER by pushTasks. So there is a window where the ROW is NEWER than the DOC.
 *
 * Bug 1 (2026-06-07, single device, phone OFF — synclog 7743d2fd): a force-poll
 *   merge landing in that window read the STALE doc, merged it, and materialized
 *   a row OLDER than the live row over it — status reverted, typed feedback
 *   vanished, updatedAt ran backwards. Fixed in 5d93d3f by reconcileLiveRow:
 *   merge first, then re-fold the whole live row on top when it is newer.
 *
 * Bug 2 (#25, found by reading while fixing #24): that re-fold applies the WHOLE
 *   row over the merge at the row's clock — including fields the row never
 *   touched. Remote changes field X at T2; the local row changes field Y at
 *   T3 > T2 (doc still at T1). The merge correctly keeps X@T2, then the re-fold
 *   overwrites X with the row's stale T1 value stamped T3, and the next push
 *   ships the clobber. Same shape as #24 on the push side.
 *
 * The INVARIANT this encodes:
 *   Row → doc → merge. The live row is serialized into OUR OWN doc first
 *   (applyTaskFields stamps only the fields the row changed, at the row's
 *   clock), and only then LWW-merged with the remote. The row's edit is then
 *   one more stamped write the per-field merge resolves by time: it survives
 *   (bug 1) without clobbering a newer remote field it never touched (bug 2).
 *   Nothing is re-folded afterwards.
 *
 * Checks:
 *   (A) OLD order — merge, then reconcileLiveRow            -> S4 expected to FAIL
 *   (B) NEW order — applyTaskFields, then mergeTaskLWW      -> all expected PASS
 *   (C) notes still use reconcileLiveRow (until #26) — body-safety check kept
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
async function makeState({ docStatus, docUpd, docExtra = {}, remoteStatus, remoteUpd, remoteExtra = {}, rowStatus, rowUpd, rowExtra = {} }) {
  // Common ancestor so local & remote share Automerge history (the `lww` path).
  const baseDoc = await createDoc('task', { id: 'tX', title: 'graph task', status: 'active', createdAt: C0, updatedAt: docUpd, ...docExtra })
  const baseBytes = A.save(baseDoc)

  // Local doc bytes = what's in IDB `_doc` right now (last serialized push).
  const localDoc = A.load(baseBytes)
  const localBytes = A.save(await applyTaskFields(localDoc, { id: 'tX', title: 'graph task', status: docStatus, createdAt: C0, updatedAt: docUpd, ...docExtra }))

  // Remote .bin fetched by the poll — diverge from the same base.
  const remoteDoc = A.load(baseBytes)
  const remoteBytes = A.save(await applyTaskFields(remoteDoc, { id: 'tX', title: 'graph task', status: remoteStatus, createdAt: C0, updatedAt: remoteUpd, ...docExtra, ...remoteExtra }))

  // The LIVE ROW (IndexedDB JSON) — what updateTask wrote, ahead of the doc.
  const liveRow = { id: 'tX', title: 'graph task', status: rowStatus, createdAt: C0, updatedAt: rowUpd, ...docExtra, ...rowExtra }

  return { localBytes, remoteBytes, liveRow }
}

// Faithful model of mergeTaskDocs' core (shared ancestry -> mergeTaskLWW),
// parameterised by the order: OLD = merge, then re-fold the live row over the
// result (reconcileLiveRow); NEW = fold the row into the local doc, then merge.
async function mergeAndMaterialize({ localBytes, remoteBytes, liveRow }, { applyThenMerge }) {
  let localDoc = A.load(localBytes)
  const remoteDoc = A.load(remoteBytes)
  let mergedDoc
  if (applyThenMerge) {
    localDoc = await applyTaskFields(localDoc, liveRow)
    mergedDoc = await mergeTaskLWW(localDoc, remoteDoc)
  } else {
    mergedDoc = await mergeTaskLWW(localDoc, remoteDoc)
    mergedDoc = await reconcileLiveRow(mergedDoc, liveRow, applyTaskFields, materializeTaskRow)
  }
  return materializeTaskRow(mergedDoc)
}

async function run(label, applyThenMerge) {
  console.log(`\n=== ${label} ===`)

  // Scenario 1 — the exact live case: row says done (23:07:59), doc+remote are
  // the older pushed `active` (≈23:07:54). The merge must not revert to active.
  {
    const st = await makeState({
      docStatus: 'active',  docUpd: '2026-06-07T23:07:54.292Z',
      remoteStatus: 'active', remoteUpd: '2026-06-07T23:07:54.292Z',
      rowStatus: 'done',    rowUpd: '2026-06-07T23:07:59.251Z',
    })
    const row = await mergeAndMaterialize(st, { applyThenMerge })
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
    const row = await mergeAndMaterialize(st, { applyThenMerge })
    check('S2 typed feedback survived', row.feedback === 'my actual feedback text', `got=${JSON.stringify(row.feedback)}`)
    check('S2 updatedAt not backwards', ms(row.updatedAt) >= ms(st.liveRow.updatedAt), `merged=${row.updatedAt} live=${st.liveRow.updatedAt}`)
  }

  // Scenario 3 — doc (and remote) are AHEAD of the row: a stale row read. In
  // production the row and bytes now come from one IDB `get` (getTaskRecord),
  // so this cannot happen live — kept as the guard that a newer remote stamp
  // still beats a row's older one under the new order.
  {
    const st = await makeState({
      docStatus: 'reviewed', docUpd: '2026-06-07T23:10:00.000Z',
      remoteStatus: 'reviewed', remoteUpd: '2026-06-07T23:10:00.000Z',
      rowStatus: 'done',     rowUpd: '2026-06-07T23:09:00.000Z',
    })
    const row = await mergeAndMaterialize(st, { applyThenMerge })
    check('S3 newer doc state kept (row not forced back)', row.status === 'reviewed', `got=${row.status}`)
  }

  // Scenario 4 — #25. Doc at T1 (status active, explanation "orig"). Remote
  // edited a DIFFERENT field (explanation) at T2. The live row marked the task
  // done at T3 > T2 but never saw the remote edit, so its explanation is still
  // "orig". Both edits must survive: status from the row, explanation from the
  // remote. The old re-fold overwrote explanation with the row's stale "orig"
  // stamped T3 — a clobber the next push then shipped.
  {
    const st = await makeState({
      docStatus: 'active',    docUpd: '2026-09-10T08:00:00.000Z', docExtra: { explanation: 'orig' },
      remoteStatus: 'active', remoteUpd: '2026-09-10T08:05:00.000Z', remoteExtra: { explanation: 'remote edit @T2' },
      rowStatus: 'done',      rowUpd: '2026-09-10T08:10:00.000Z',
    })
    const row = await mergeAndMaterialize(st, { applyThenMerge })
    check('S4 row\'s own edit (status done @T3) kept', row.status === 'done', `got=${row.status}`)
    check('S4 remote different-field edit (explanation @T2) NOT clobbered by the stale row', row.explanation === 'remote edit @T2', `got=${JSON.stringify(row.explanation)}`)
    check('S4 updatedAt not older than live row', ms(row.updatedAt) >= ms(st.liveRow.updatedAt), `merged=${row.updatedAt} live=${st.liveRow.updatedAt}`)
  }
}

await run('A) OLD order (merge, then reconcileLiveRow re-fold) — S4 expected FAIL', false)
const currentFailures = failures

failures = 0
await run('B) NEW order (applyTaskFields, then mergeTaskLWW) — expected PASS', true)
const fixedFailures = failures

// --- Notes: same row/doc skew. mergeNoteDocs still uses reconcileLiveRow (the
// note-side reorder is #26). It must re-assert a newer note row WITHOUT
// clobbering a freshly-merged remote body block (blocks are id-keyed reconciled
// by applyNoteFields, never wholesale-overwritten). ---------------------------
failures = 0
console.log('\n=== C) NOTES row authority via reconcileLiveRow (body must not be clobbered) — expected PASS ===')
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
console.log(`  old order (merge → re-fold) failures: ${currentFailures}  (bug reproduced if > 0)`)
console.log(`  new order (apply → merge) failures:   ${fixedFailures}  (fix correct if 0)`)
console.log(`  notes (body-safe re-fold):            ${noteFailures}  (still correct if 0)`)
if (currentFailures > 0 && fixedFailures === 0 && noteFailures === 0) {
  console.log('  RESULT: ✓ bug reproduced AND apply-then-merge proven for tasks; notes re-fold intact')
  process.exit(0)
} else {
  console.log('  RESULT: ✗ unexpected — investigate')
  process.exit(1)
}
