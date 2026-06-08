/**
 * Repro for the "task edits silently revert across devices" bug.
 *
 * mergeTaskDocs (src/services/sync.js) merges two shared-ancestry task docs with
 * a plain `Automerge.merge`. Automerge resolves each concurrent SCALAR field by
 * its internal actor-id order — NOT by wall-clock. So when two devices edit the
 * same task's `status` concurrently, the winner is arbitrary, and the genuinely
 * newer edit can lose. Worse: `updatedAt` is itself a scalar resolved
 * independently, so the merged `updatedAt` can come from the OTHER actor than the
 * one whose `status` won — it runs backwards and poisons the disjoint-root
 * `newerDoc` tiebreak on the next device. (Captured live: mergeTaskDocs CHANGED
 * local entries where mergedUpd < localUpd, done -> reviewed reverts.)
 *
 * This script encodes the INVARIANT we want and checks it against:
 *   (A) CURRENT mechanism  — plain Automerge.merge   -> expected to FAIL
 *   (B) PROPOSED fix       — per-field wall-clock LWW -> expected to PASS
 *
 * The fix keeps business fields FLAT and adds one companion map `_fts`
 * (field -> epoch-ms). On write we stamp `_fts[field] = Date.now()` for changed
 * fields; after merge, for every field Automerge reports as conflicting we keep
 * the value whose actor's `_fts[field]` is newest (fallback updatedAt, then
 * opId). Docs without `_fts` (legacy) degrade to whole-row updatedAt LWW.
 *
 * Run: node scripts/repro-task-lww.mjs
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window

const A = await import('@automerge/automerge')

const ms = (iso) => new Date(iso).getTime()

// ---- model of CURRENT mergeTaskDocs (shared ancestry -> plain merge) ----------
function mergeCurrent(localDoc, remoteDoc) {
  return A.merge(A.clone(localDoc), remoteDoc)
}

// ---- model of PROPOSED fix: per-field wall-clock LWW via _fts + getConflicts ---
const LWW_FALLBACK = ['updatedAt'] // legacy docs with no _fts use the row clock
function resolveLWW(doc, fields) {
  return A.change(doc, (d) => {
    const rowTs = ms(d.updatedAt || 0)
    for (const f of fields) {
      const vConf = A.getConflicts(d, f)
      if (!vConf) continue
      const opIds = Object.keys(vConf)
      if (opIds.length <= 1) continue // no concurrent write to this field
      const tConf = (d._fts && A.getConflicts(d._fts, f)) || {}
      // ts indexed by actor id (the part after `@` in an opId)
      const tByActor = {}
      for (const [k, v] of Object.entries(tConf)) tByActor[k.split('@')[1]] = v
      let best, bestT = -Infinity, bestK = ''
      for (const k of opIds) {
        const actor = k.split('@')[1]
        const t = tByActor[actor] ?? (d._fts?.[f] ?? rowTs) // fallback to row clock
        if (t > bestT || (t === bestT && k > bestK)) { bestT = t; best = vConf[k]; bestK = k }
      }
      if (d[f] !== best) d[f] = best
      if (d._fts && d._fts[f] !== bestT) d._fts[f] = bestT
    }
  })
}
function mergeFixed(localDoc, remoteDoc, fields) {
  return resolveLWW(A.merge(A.clone(localDoc), remoteDoc), fields)
}

// stamp helper mirroring the proposed applyTaskFields: set field + _fts[field]
function edit(doc, patch, atMs) {
  return A.change(doc, (d) => {
    if (!d._fts) d._fts = {}
    for (const [k, v] of Object.entries(patch)) {
      if (d[k] !== v) { d[k] = v; d._fts[k] = atMs }
    }
    d.updatedAt = new Date(atMs).toISOString()
    d._fts.updatedAt = atMs
  })
}

// --------------------------------- assertions ----------------------------------
let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!pass) failures++
}

function run(label, mergeFn) {
  console.log(`\n=== ${label} ===`)

  // Scenario 1: SAME field, concurrent. Phone marks done (NEWER) while laptop
  // marks reviewed (OLDER). Newer must win, both devices must converge.
  {
    let base = A.from({ id: 't1', status: 'active', updatedAt: '2026-06-06T10:00:00.000Z', _fts: { status: ms('2026-06-06T10:00:00.000Z') } })
    const by = A.save(base)
    const laptop = edit(A.load(by), { status: 'reviewed' }, ms('2026-06-06T16:48:00.000Z'))
    const phone = edit(A.load(by), { status: 'done' }, ms('2026-06-06T20:18:00.000Z'))
    const mLP = mergeFn(A.load(A.save(laptop)), A.load(A.save(phone)))
    const mPL = mergeFn(A.load(A.save(phone)), A.load(A.save(laptop)))
    check('S1 newer edit (done) wins', mLP.status === 'done' && mPL.status === 'done', `LP=${mLP.status} PL=${mPL.status}`)
    check('S1 both devices converge', mLP.status === mPL.status, `LP=${mLP.status} PL=${mPL.status}`)
    check('S1 updatedAt not older than winner', ms(mLP.updatedAt) >= ms('2026-06-06T20:18:00.000Z'), `merged=${mLP.updatedAt}`)
  }

  // Scenario 2: DIFFERENT fields, concurrent. Phone marks done; laptop adds
  // feedback to the SAME task. No edit may be lost (this is why per-field).
  {
    let base = A.from({ id: 't2', status: 'active', feedback: '', updatedAt: '2026-06-06T10:00:00.000Z', _fts: { status: ms('2026-06-06T10:00:00.000Z'), feedback: ms('2026-06-06T10:00:00.000Z') } })
    const by = A.save(base)
    const laptop = edit(A.load(by), { feedback: 'from laptop' }, ms('2026-06-06T16:48:00.000Z'))
    const phone = edit(A.load(by), { status: 'done' }, ms('2026-06-06T20:18:00.000Z'))
    const mLP = mergeFn(A.load(A.save(laptop)), A.load(A.save(phone)))
    const mPL = mergeFn(A.load(A.save(phone)), A.load(A.save(laptop)))
    check('S2 both edits kept (done + feedback)', mLP.status === 'done' && mLP.feedback === 'from laptop', `status=${mLP.status} feedback=${JSON.stringify(mLP.feedback)}`)
    check('S2 both devices converge', mLP.status === mPL.status && mLP.feedback === mPL.feedback)
  }

  // Scenario 3: the exact live regression — local NEWER `done` vs remote OLDER
  // `reviewed`, merged result must not revert to reviewed nor move updatedAt back.
  {
    let base = A.from({ id: 't3', status: 'active', updatedAt: '2026-06-05T12:00:00.000Z', _fts: { status: ms('2026-06-05T12:00:00.000Z') } })
    const by = A.save(base)
    const remote = edit(A.load(by), { status: 'reviewed' }, ms('2026-06-06T16:48:55.428Z')) // laptop, older
    const local = edit(A.load(by), { status: 'done' }, ms('2026-06-06T22:34:21.736Z'))     // phone, newer
    const merged = mergeFn(A.load(A.save(local)), A.load(A.save(remote)))
    check('S3 newer local "done" not reverted', merged.status === 'done', `got=${merged.status}`)
    check('S3 updatedAt did not run backwards', ms(merged.updatedAt) >= ms(local.updatedAt), `merged=${merged.updatedAt} local=${local.updatedAt}`)
  }
}

run('A) CURRENT mergeTaskDocs (plain Automerge.merge) — expected FAIL', (l, r) => mergeCurrent(l, r))
const currentFailures = failures

failures = 0
run('B) PROTOTYPE per-field LWW (inline _fts + getConflicts) — expected PASS', (l, r) => mergeFixed(l, r, ['status', 'feedback', 'updatedAt']))
const fixedFailures = failures

// C) Validate the REAL shipped functions (applyTaskFields stamps _fts;
// mergeTaskLWW does the per-field wall-clock merge), not just the inline
// prototype. This is the check that src/ actually upholds the invariant.
const { applyTaskFields, mergeTaskLWW, createDoc } = await import('../src/services/automergeDoc.js')
async function realEdit(bytes, patch, atMs) {
  // Mirror updateTask: row carries updatedAt; applyTaskFields stamps _fts.
  const A2 = await import('@automerge/automerge')
  const doc = A2.load(bytes)
  // Build a row = current materialized fields + patch + new updatedAt.
  const row = {}
  for (const [k, v] of Object.entries(doc)) { if (k !== '_fts') row[k] = JSON.parse(JSON.stringify(v)) }
  Object.assign(row, patch, { updatedAt: new Date(atMs).toISOString() })
  return A2.save(await applyTaskFields(doc, row))
}
async function realMerge(lBytes, rBytes) {
  const A2 = await import('@automerge/automerge')
  return await mergeTaskLWW(A2.load(lBytes), A2.load(rBytes))
}
failures = 0
console.log('\n=== C) REAL src/ functions (applyTaskFields + resolveTaskLWW) — expected PASS ===')
{
  const A2 = await import('@automerge/automerge')
  const C0 = '2026-06-06T09:00:00.000Z' // realistic createdAt: before any edit
  // S1: same field, newer wins, converge
  let base = A2.save(await createDoc('task', { id: 't1', status: 'active', createdAt: C0, updatedAt: '2026-06-06T10:00:00.000Z' }))
  const laptop = await realEdit(base, { status: 'reviewed' }, ms('2026-06-06T16:48:00.000Z'))
  const phone = await realEdit(base, { status: 'done' }, ms('2026-06-06T20:18:00.000Z'))
  const mLP = await realMerge(laptop, phone)
  const mPL = await realMerge(phone, laptop)
  check('C-S1 newer "done" wins + converges', mLP.status === 'done' && mPL.status === 'done', `LP=${mLP.status} PL=${mPL.status}`)
  check('C-S1 updatedAt not backwards', ms(mLP.updatedAt) >= ms('2026-06-06T20:18:00.000Z'), `merged=${mLP.updatedAt}`)
  // S2: different fields, no loss
  let base2 = A2.save(await createDoc('task', { id: 't2', status: 'active', feedback: '', createdAt: C0, updatedAt: '2026-06-06T10:00:00.000Z' }))
  const lap2 = await realEdit(base2, { feedback: 'from laptop' }, ms('2026-06-06T16:48:00.000Z'))
  const ph2 = await realEdit(base2, { status: 'done' }, ms('2026-06-06T20:18:00.000Z'))
  const m2 = await realMerge(lap2, ph2)
  const m2b = await realMerge(ph2, lap2)
  check('C-S2 both edits kept (done + feedback)', m2.status === 'done' && m2.feedback === 'from laptop', `status=${m2.status} feedback=${JSON.stringify(m2.feedback)}`)
  check('C-S2 converges both merge directions', m2.status === m2b.status && m2.feedback === m2b.feedback, `LP={${m2.status},${m2.feedback}} PL={${m2b.status},${m2b.feedback}}`)
}
const realFailures = failures

// D) NOTES use the same fix (mergeNoteLWW), but `blocks` must be left to
// Automerge's id-keyed merge — scalar LWW must NOT clobber the note body.
const { applyNoteFields, mergeNoteLWW } = await import('../src/services/automergeDoc.js')
failures = 0
console.log('\n=== D) REAL notes (applyNoteFields + mergeNoteLWW) — expected PASS ===')
{
  const A2 = await import('@automerge/automerge')
  const C0 = '2026-06-06T09:00:00.000Z'
  const noteEdit = async (bytes, patch, atMs) => {
    const doc = A2.load(bytes)
    const row = {}
    for (const [k, v] of Object.entries(doc)) { if (k !== '_fts') row[k] = JSON.parse(JSON.stringify(v)) }
    Object.assign(row, patch, { updatedAt: new Date(atMs).toISOString() })
    return A2.save(await applyNoteFields(doc, row))
  }
  // Base note with a title + one body block.
  let base = A2.save(await createDoc('note', {
    id: 'n1', title: 'orig', createdAt: C0, updatedAt: '2026-06-06T10:00:00.000Z',
    blocks: [{ id: 'b1', html: '<p>body</p>', deleted: false, updatedAt: C0, order: 'a0' }],
  }))
  // Laptop retitles (older); phone edits the body block (newer). Title LWW must
  // pick laptop's title; the body edit must survive (blocks not LWW-clobbered).
  const laptop = await noteEdit(base, { title: 'laptop title' }, ms('2026-06-06T16:48:00.000Z'))
  const phone = await noteEdit(base, {
    blocks: [{ id: 'b1', html: '<p>phone body</p>', deleted: false, updatedAt: '2026-06-06T20:18:00.000Z', order: 'a0' }],
  }, ms('2026-06-06T20:18:00.000Z'))
  const m = await mergeNoteLWW(A2.load(laptop), A2.load(phone))
  const mb = await mergeNoteLWW(A2.load(phone), A2.load(laptop))
  const body = (d) => (d.blocks || []).find(b => b.id === 'b1')?.html
  check('D-S1 title LWW = laptop (older but only title edit)', m.title === 'laptop title', `title=${m.title}`)
  check('D-S1 body block preserved (not LWW-clobbered)', body(m) === '<p>phone body</p>', `body=${body(m)}`)
  check('D-S1 converges both directions', m.title === mb.title && body(m) === body(mb), `LP={${m.title},${body(m)}} PL={${mb.title},${body(mb)}}`)
}
const noteFailures = failures

console.log('\n=== SUMMARY ===')
console.log(`  current mechanism failures: ${currentFailures}  (bug reproduced if > 0)`)
console.log(`  prototype fix failures:     ${fixedFailures}  (prototype correct if 0)`)
console.log(`  REAL task src/ failures:    ${realFailures}  (shipped code correct if 0)`)
console.log(`  REAL note src/ failures:    ${noteFailures}  (shipped code correct if 0)`)
if (currentFailures > 0 && fixedFailures === 0 && realFailures === 0 && noteFailures === 0) {
  console.log('  RESULT: ✓ bug reproduced AND task+note fix proven in real code')
  process.exit(0)
} else {
  console.log('  RESULT: ✗ unexpected — investigate')
  process.exit(1)
}
