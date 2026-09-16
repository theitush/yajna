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
 * Bug 3 (#27, the note twin of bug 2): mergeNoteDocs carried the same re-fold.
 *   On a note the whole row goes back over the merge, so BOTH halves clobber:
 *   a scalar the row never touched (title) is written back at the row's clock,
 *   and a block the row holds STALE beats the freshly-merged remote html
 *   outright — the #26 S2 shape, on the pull side. Same fix, same order, and
 *   with it `reconcileLiveRow` lost its last caller and was deleted from
 *   src/services/automergeDoc.js (the OLD order is modelled locally below).
 *
 * Checks:
 *   (A) TASKS old order — merge, then reconcileLiveRow       -> S4 expected to FAIL
 *   (B) TASKS new order — applyTaskFields, then mergeTaskLWW  -> all expected PASS
 *   (C) NOTES old order — merge, then reconcileLiveRow       -> C2/C3 expected to FAIL
 *   (D) NOTES new order — applyNoteFields, then mergeNoteLWW  -> all expected PASS
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
} = await import('../src/services/automergeDoc.js')

/**
 * The OLD order's second step, verbatim as `reconcileLiveRow` was before #27
 * deleted it from src/services/automergeDoc.js: merge first, then re-fold the
 * WHOLE live row over the result when the row's clock is newer. Kept here (and
 * only here) so this repro can still run the buggy order it exists to prove.
 */
async function reconcileLiveRow(mergedDoc, liveRow, applyFields, materialize) {
  if (!liveRow) return mergedDoc
  const rowUpd = new Date(liveRow.updatedAt || 0).getTime()
  const docUpd = new Date(materialize(mergedDoc)?.updatedAt || 0).getTime()
  if (rowUpd <= docUpd) return mergedDoc
  return applyFields(mergedDoc, liveRow)
}

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

// --- Notes: the same row/doc skew, and the same fix (#27). mergeNoteDocs used
// to merge and THEN re-fold the whole live row (reconcileLiveRow). A note row
// carries blocks as well as scalars, so that re-fold clobbers twice over:
// a scalar the row never touched, and a block the row holds stale. -----------

const blk = (id, html, order, at) => ({ id, html, deleted: false, order, updatedAt: at })

/**
 * Faithful model of mergeNoteDocs' core, parameterised the same way as the task
 * one: OLD = mergeNoteLWW, then re-fold the live row; NEW = fold the row into
 * our own doc (applyNoteFields), then mergeNoteLWW.
 */
async function noteMergeAndMaterialize({ localBytes, remoteBytes, liveRow }, { applyThenMerge }) {
  let localDoc = A.load(localBytes)
  const remoteDoc = A.load(remoteBytes)
  let mergedDoc
  if (applyThenMerge) {
    localDoc = await applyNoteFields(localDoc, liveRow)
    mergedDoc = await mergeNoteLWW(localDoc, remoteDoc)
  } else {
    mergedDoc = await mergeNoteLWW(localDoc, remoteDoc)
    mergedDoc = await reconcileLiveRow(mergedDoc, liveRow, applyNoteFields, materializeNoteRow)
  }
  return materializeNoteRow(mergedDoc)
}

/** Shared ancestor note: title "orig", one body block b1. */
async function noteBase() {
  return A.save(await createDoc('note', {
    id: 'nX', title: 'orig', createdAt: C0, updatedAt: '2026-06-07T10:00:00.000Z',
    blocks: [blk('b1', '<p>body</p>', 'a0', C0)],
  }))
}

async function runNotes(label, applyThenMerge) {
  console.log(`\n=== ${label} ===`)

  // C1 — the body-safety case the re-fold was trusted for: the row retitles
  // (newer than the doc) while the remote APPENDED a block the row's editor
  // snapshot has never seen. Both must survive under either order.
  {
    const base = await noteBase()
    const remoteBytes = A.save(await applyNoteFields(A.load(base), {
      id: 'nX', title: 'orig', createdAt: C0, updatedAt: '2026-06-07T10:05:00.000Z',
      blocks: [blk('b1', '<p>body</p>', 'a0', C0), blk('b2', '<p>remote add</p>', 'a1', '2026-06-07T10:05:00.000Z')],
    }))
    const liveRow = {
      id: 'nX', title: 'my new title', createdAt: C0, updatedAt: '2026-06-07T10:06:00.000Z',
      blocks: [blk('b1', '<p>body</p>', 'a0', C0)],
    }
    const row = await noteMergeAndMaterialize({ localBytes: base, remoteBytes, liveRow }, { applyThenMerge })
    const live = (row.blocks || []).filter(b => !b.deleted).map(b => b.id).sort()
    check('C1 title from the newer row', row.title === 'my new title', `title=${row.title}`)
    check('C1 remote-added block b2 NOT clobbered', live.includes('b2'), `blocks=${JSON.stringify(live)}`)
    check('C1 own block b1 still present', live.includes('b1'), `blocks=${JSON.stringify(live)}`)
  }

  // C2 — #27, scalar half: doc at T1. The remote RETITLED at T2. The live row
  // edited a BLOCK at T3 > T2 and never saw the retitle, so its title is still
  // the stale "orig". Both edits must survive: the block from the row, the
  // title from the remote. The old re-fold wrote "orig" back at T3.
  {
    const base = await noteBase()
    const remoteBytes = A.save(await applyNoteFields(A.load(base), {
      id: 'nX', title: 'retitled on laptop', createdAt: C0, updatedAt: '2026-09-10T08:05:00.000Z',
      blocks: [blk('b1', '<p>body</p>', 'a0', C0)],
    }))
    const liveRow = {
      id: 'nX', title: 'orig', createdAt: C0, updatedAt: '2026-09-10T08:10:00.000Z',
      blocks: [blk('b1', '<p>body, edited on phone</p>', 'a0', '2026-09-10T08:10:00.000Z')],
    }
    const row = await noteMergeAndMaterialize({ localBytes: base, remoteBytes, liveRow }, { applyThenMerge })
    const b1 = (row.blocks || []).find(b => b.id === 'b1')
    check("C2 row's own block edit (@T3) kept", b1?.html === '<p>body, edited on phone</p>', `html=${JSON.stringify(b1?.html)}`)
    check('C2 remote title (@T2) NOT clobbered by the stale row', row.title === 'retitled on laptop', `title=${JSON.stringify(row.title)}`)
    check('C2 updatedAt not older than live row', ms(row.updatedAt) >= ms(liveRow.updatedAt), `merged=${row.updatedAt} live=${liveRow.updatedAt}`)
  }

  // C3 — #27, block half: the remote edited BLOCK b1 at T2. The live row
  // retitled at T3 > T2 and its editor snapshot still holds b1's OLD html.
  // The re-fold wrote that stale html back over the freshly-merged remote one
  // (#26 S2, on the pull side); apply-then-merge leaves the untouched block
  // unstamped, so the remote's newer stamp wins it.
  {
    const base = await noteBase()
    const remoteBytes = A.save(await applyNoteFields(A.load(base), {
      id: 'nX', title: 'orig', createdAt: C0, updatedAt: '2026-09-10T08:05:00.000Z',
      blocks: [blk('b1', '<p>body, edited on laptop</p>', 'a0', '2026-09-10T08:05:00.000Z')],
    }))
    const liveRow = {
      id: 'nX', title: 'my new title', createdAt: C0, updatedAt: '2026-09-10T08:10:00.000Z',
      blocks: [blk('b1', '<p>body</p>', 'a0', C0)],
    }
    const row = await noteMergeAndMaterialize({ localBytes: base, remoteBytes, liveRow }, { applyThenMerge })
    const b1 = (row.blocks || []).find(b => b.id === 'b1')
    check("C3 row's own retitle (@T3) kept", row.title === 'my new title', `title=${JSON.stringify(row.title)}`)
    check('C3 remote block edit (@T2) NOT clobbered by the stale row block', b1?.html === '<p>body, edited on laptop</p>', `html=${JSON.stringify(b1?.html)}`)
  }
}

failures = 0
await runNotes('C) NOTES old order (merge, then reconcileLiveRow re-fold) — C2/C3 expected FAIL', false)
const noteCurrentFailures = failures

failures = 0
await runNotes('D) NOTES new order (applyNoteFields, then mergeNoteLWW) — expected PASS', true)
const noteFixedFailures = failures

console.log('\n=== SUMMARY ===')
console.log(`  tasks old order (merge \u2192 re-fold) failures: ${currentFailures}  (bug reproduced if > 0)`)
console.log(`  tasks new order (apply \u2192 merge) failures:   ${fixedFailures}  (fix correct if 0)`)
console.log(`  notes old order (merge \u2192 re-fold) failures: ${noteCurrentFailures}  (bug reproduced if > 0)`)
console.log(`  notes new order (apply \u2192 merge) failures:   ${noteFixedFailures}  (fix correct if 0)`)
if (currentFailures > 0 && fixedFailures === 0 && noteCurrentFailures > 0 && noteFixedFailures === 0) {
  console.log('  RESULT: \u2713 both bugs reproduced AND apply-then-merge proven for tasks and notes')
  process.exit(0)
} else {
  console.log('  RESULT: \u2717 unexpected \u2014 investigate')
  process.exit(1)
}
