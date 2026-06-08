/**
 * Repro for the CROSS-DEVICE "edited a task's feedback on the phone, stale on
 * the laptop" data loss. Captured live (phone synclog e2daf12b (16) + laptop
 * (7)/(8) + manifest(9), 2026-06-08).
 *
 * The sequence on the phone for one task (9bfed1b1), ~1s apart:
 *   18:11:00.499  updateTask(status, doneDate)        -> markDirty, fires push A
 *   18:11:01.432  updateTask(explanation, feedback…)  -> markDirty, fires push B
 * pushTasks is fire-and-forget (executePush runs it immediately; a second call
 * while one is in flight is PARKED as coalescedPush). So:
 *   • Push A starts, snapshots the row (done-only, no new feedback), uploads it,
 *     then clearDirty([id]).
 *   • Push B was parked; it drains after A and calls getDirty() -> EMPTY,
 *     because A just cleared the flag B's edit had set. B ships nothing.
 * The feedback edit therefore NEVER reaches Drive. The phone's own local doc was
 * healed by the post-push force-poll re-fold (reconcileLiveRow), so the PHONE
 * shows the feedback — but Drive (and the laptop) stay frozen at the done write.
 * Proof in the logs: the laptop merged docs whose mergedUpd is the *done* write
 * (18:11:00.496 / 18:11:14.680), never the *feedback* write (…01.429 / …15.574),
 * and `feedback` never appears in mergeTaskDocs `changedFields` for either id.
 *
 * Root cause: the dirty marker was a BOOLEAN. A second markDirty on an already-
 * dirty id is a no-op, so the two distinct edit versions are indistinguishable,
 * and clearDirty(id) after push A wipes the flag push B relied on. The fix makes
 * the marker a strictly-increasing TOKEN and clearDirty a COMPARE-AND-CLEAR:
 * only remove an id when its stored token still equals the one the push shipped.
 * A mid-push re-edit keeps a newer token and survives for the coalesced push.
 *
 * This models the dirty store + the A/B coalesced-push interleave only (no IDB,
 * no Automerge — the bug lives entirely in the dirty-flag lifecycle).
 *
 * Checks:
 *   (A) BOOLEAN dirty flag (old behavior)        -> expected FAIL (edit lost)
 *   (B) TOKEN dirty flag + compare-and-clear      -> expected PASS (edit shipped)
 *
 * Run: node scripts/repro-dirty-clear-lostupdate.mjs
 */

// --- A model of the dirty meta store (just the `dirty_task` map). ---
function makeStore() {
  return { map: {} }
}

// --- BOOLEAN variant (the bug) ---
function markDirtyBool(store, id) {
  if (store.map[id]) return // no-op when already dirty — loses the 2nd version
  store.map[id] = true
}
function clearDirtyBool(store, ids) {
  for (const id of ids) delete store.map[id]
}

// --- TOKEN variant (the fix) ---
let seq = 0
function nextToken() {
  seq += 1
  return Date.now() * 1000 + (seq % 1000)
}
function markDirtyTok(store, id) {
  store.map[id] = nextToken() // always bump, even if already dirty
}
function clearDirtyTok(store, pushed) {
  // pushed is { id: token }; only clear when the stored token still matches.
  for (const id of Object.keys(pushed)) {
    if (store.map[id] !== pushed[id]) continue
    delete store.map[id]
  }
}

/**
 * Run the live interleave: two edits to the same id, then push A (in flight),
 * then a coalesced push B. Drive ends up with whatever the LAST successful push
 * shipped for that id. We assert Drive has the 2nd edit's payload ("feedback").
 *
 * `variant` selects mark/clear + how a push records what it cleared.
 */
function runInterleave({ markDirty, clearDirty, captureMap }) {
  const store = makeStore()
  const drive = {}          // id -> last shipped payload
  const rows = {}           // id -> current live row (the IDB row)

  const id = '9bfed1b1'

  // Edit 1: mark done (no new feedback yet).
  rows[id] = { status: 'done', feedback: '(old)' }
  markDirty(store, id)

  // Push A reads the dirty set and SNAPSHOTS the row NOW (mid-flight async).
  const aDirty = { ...store.map }
  const aSnapshotRow = { ...rows[id] }
  const aToken = aDirty[id]

  // Edit 2 lands WHILE push A is in flight: the feedback the user typed.
  rows[id] = { status: 'done', feedback: '(NEW feedback)' }
  markDirty(store, id)

  // Push A finishes: ships its (stale) snapshot, then clears what it shipped.
  drive[id] = aSnapshotRow.feedback
  clearDirty(store, captureMap ? { [id]: aToken } : [id])

  // Push B (the parked coalesced push) drains: re-reads dirty, ships fresh row.
  const bDirty = { ...store.map }
  if (bDirty[id] != null) {
    const bToken = bDirty[id]
    drive[id] = rows[id].feedback // fresh row read right before serialize
    clearDirty(store, captureMap ? { [id]: bToken } : [id])
  }

  return drive[id]
}

let pass = true

// (A) boolean — expected to LOSE the feedback.
const aResult = runInterleave({
  markDirty: markDirtyBool,
  clearDirty: clearDirtyBool,
  captureMap: false,
})
const aLost = aResult !== '(NEW feedback)'
console.log(`(A) boolean flag        -> drive feedback = ${JSON.stringify(aResult)}  ${aLost ? 'LOST (bug reproduced ✓)' : 'kept (no repro ✗)'}`)
if (!aLost) pass = false

// (B) token — expected to KEEP the feedback.
const bResult = runInterleave({
  markDirty: markDirtyTok,
  clearDirty: clearDirtyTok,
  captureMap: true,
})
const bKept = bResult === '(NEW feedback)'
console.log(`(B) token + cmp-clear   -> drive feedback = ${JSON.stringify(bResult)}  ${bKept ? 'KEPT (fix works ✓)' : 'LOST (fix broken ✗)'}`)
if (!bKept) pass = false

console.log(pass ? '\nPASS — fix closes the lost-update.' : '\nFAIL.')
process.exit(pass ? 0 : 1)
