/**
 * Prototype of the CORRECT fix: append-only Automerge list + per-block `order`
 * fractional-index key; sort by `order` on read. Never deleteAt/insertAt for
 * reordering. Proves the doubled-run bug disappears under concurrent reorder.
 *
 * This models the intended applyJournalFields behavior WITHOUT touching the real
 * file yet:
 *   - Pass 1: update existing block fields in place (incl. `order`).
 *   - Pass 2: append blocks whose id isn't already in the list.
 *   - NO Pass 3 splice. Order is carried in the `order` field.
 *   - materialize: sort live blocks by `order`.
 *
 * Run: node scripts/repro-orderkey-fix.mjs
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window

const A = await import('@automerge/automerge')
const { fiBetween } = await import('../src/lib/blocks.js')

const BLOCK_FIELDS = ['id', 'html', 'deleted', 'updatedAt', 'order']

// Apply a desired ordered list of {id,html} into doc.blocks, append-only.
// `desired` is the editor's block list in display order; we compute an `order`
// key for each from the surrounding anchors that already exist in the doc.
function apply(doc, desired) {
  return A.change(doc, (d) => {
    if (!Array.isArray(d.blocks)) d.blocks = []
    const docById = new Map()
    for (const b of d.blocks) if (b.id) docById.set(b.id, b)

    // Assign order keys: keep existing block's order if present; for new/missing
    // ones, generate strictly between the previous assigned key and the next
    // existing anchor key (mirrors stampBlocksFromDoc's anchor logic, simplified).
    const desiredOrders = []
    let prevKey = null
    for (let i = 0; i < desired.length; i++) {
      const ex = docById.get(desired[i].id)
      if (ex && ex.order && (prevKey == null || ex.order > prevKey)) {
        desiredOrders[i] = ex.order
        prevKey = ex.order
      } else {
        // find next anchor
        let hi = null
        for (let j = i + 1; j < desired.length; j++) {
          const e2 = docById.get(desired[j].id)
          if (e2 && e2.order && (prevKey == null || e2.order > prevKey)) { hi = e2.order; break }
        }
        const key = fiBetween(prevKey, hi)
        desiredOrders[i] = key
        prevKey = key
      }
    }

    const desiredIds = new Set(desired.map(b => b.id))
    // Pass 1: update existing in place (fields + order); tombstone if explicitly
    // absent is NOT done here (we only tombstone on explicit delete in real code).
    for (let i = 0; i < d.blocks.length; i++) {
      const cur = d.blocks[i]
      if (!cur?.id) continue
      const idx = desired.findIndex(x => x.id === cur.id)
      if (idx < 0) continue
      const want = { id: desired[idx].id, html: desired[idx].html, deleted: false, updatedAt: '2026-01-03T00:00:00.000Z', order: desiredOrders[idx] }
      for (const k of BLOCK_FIELDS) if (cur[k] !== want[k]) cur[k] = want[k]
    }
    // Pass 2: append new ids only.
    const present = new Set(d.blocks.map(b => b.id))
    for (let i = 0; i < desired.length; i++) {
      if (present.has(desired[i].id)) continue
      d.blocks.push({ id: desired[i].id, html: desired[i].html, deleted: false, updatedAt: '2026-01-03T00:00:00.000Z', order: desiredOrders[i] })
    }
  })
}

function liveSorted(doc) {
  return (doc.blocks || []).filter(b => !b.deleted)
    .slice().sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : (a.id < b.id ? -1 : 1)))
    .map(b => b.id)
}
const hasDup = (doc) => { const ids = (doc.blocks||[]).filter(b=>!b.deleted).map(b=>b.id); return new Set(ids).size !== ids.length }

console.log('=== Order-key fix: concurrent reorder must NOT duplicate ===')
let base = A.from({ date: 'd1', blocks: [] })
base = apply(base, [{id:'a',html:'A'},{id:'b',html:'B'},{id:'c',html:'C'},{id:'d',html:'D'}])
const baseBytes = A.save(base)

let X = A.load(baseBytes), Y = A.load(baseBytes)
X = apply(X, [{id:'b',html:'B'},{id:'a',html:'A'},{id:'c',html:'C'},{id:'d',html:'D'}]) // X: swap a,b
Y = apply(Y, [{id:'a',html:'A'},{id:'c',html:'C'},{id:'b',html:'B'},{id:'d',html:'D'}]) // Y: move b after c

let merged = A.merge(A.clone(X), Y)
console.log('  live (sorted by order):', liveSorted(merged))
console.log('  raw list len:', (merged.blocks||[]).length, '| has dup live id?', hasDup(merged), hasDup(merged) ? ' <-- STILL BROKEN' : ' <-- OK, no duplication')

for (let i = 0; i < 3; i++) {
  let mx = apply(A.clone(merged), [{id:'b',html:'B'},{id:'a',html:'A'},{id:'c',html:'C'},{id:'d',html:'D'}])
  let my = apply(A.clone(merged), [{id:'a',html:'A'},{id:'c',html:'C'},{id:'b',html:'B'},{id:'d',html:'D'}])
  merged = A.merge(A.clone(mx), my)
  console.log(`  round ${i}: rawLen=${(merged.blocks||[]).length} liveCount=${liveSorted(merged).length} dup?=${hasDup(merged)}`)
}
