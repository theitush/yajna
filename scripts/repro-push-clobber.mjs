/**
 * Repro of the push-side clobber (2026-06-11 "laptop's line vanished"):
 *
 *   1. Both devices share a journal doc with one block.
 *   2. LAPTOP pushes a new text line  → Drive has it.
 *   3. PHONE — which never pulled the laptop's push — pushes a new audio
 *      block via journalApply (boot loadJournal→pushJournal, seq 4504).
 *
 * The old journalApply only used the fetched remote bytes for the
 * disjoint-root check and uploaded the phone's lineage alone, so step 3
 * REPLACED the Drive file with a doc that never contained the laptop's line.
 * The laptop's dirty token was already cleared by its own successful push, so
 * the line was never re-pushed — gone from Drive until the laptop happened to
 * edit that day again. Read-merge-write (mergeDoc when ancestry is shared)
 * makes the upload a superset of the file it replaces.
 *
 * Run: node scripts/repro-push-clobber.mjs   (exits 1 on clobber)
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window

const { journalApply } = await import('../src/services/automergeInline.js')
const { loadDoc, materializeJournalRow } = await import('../src/services/automergeDoc.js')

const block = (id, html, order) => ({ id, html, order, deleted: false })
const row = (blocks, updatedAt) => ({ date: '2026-06-10', blocks, updatedAt })

// Step 1 — first writer creates the day; both devices then hold these bytes.
const t0 = '2026-06-11T05:00:00.000Z'
const base = await journalApply({
  existingBytes: null,
  remoteBytes: null,
  source: row([block('A', '<p data-bid="A">existing entry</p>', 'a')], t0),
})
let drive = base.bytes
const laptopLocal = base.bytes
const phoneLocal = base.bytes

// Step 2 — laptop pushes its new text line (seqs 4496–4503).
const laptopPush = await journalApply({
  existingBytes: laptopLocal,
  remoteBytes: drive,
  source: row([
    block('A', '<p data-bid="A">existing entry</p>', 'a'),
    block('LINE', '<p data-bid="LINE">the laptop line</p>', 'b'),
  ], '2026-06-11T05:12:00.000Z'),
})
drive = laptopPush.bytes

// Step 3 — phone pushes its audio block WITHOUT having pulled the laptop's
// push (its source row knows nothing about LINE). This is the clobber moment.
const phonePush = await journalApply({
  existingBytes: phoneLocal,
  remoteBytes: drive,
  source: row([
    block('A', '<p data-bid="A">existing entry</p>', 'a'),
    block('AUDIO', '<p data-bid="AUDIO">audio block</p>', 'c'),
  ], '2026-06-11T05:18:18.000Z'),
})
drive = phonePush.bytes

const final = materializeJournalRow(await loadDoc(drive))
const liveIds = final.blocks.filter(b => !b.deleted).map(b => b.id).sort()
console.log('Drive blocks after both pushes:', liveIds.join(', '))

const ok = liveIds.includes('LINE') && liveIds.includes('AUDIO') && liveIds.includes('A')
if (!ok) {
  console.error('CLOBBERED: the laptop line was erased from Drive by the phone push')
  process.exit(1)
}
console.log('OK: push is read-merge-write — both devices’ changes survive on Drive')
