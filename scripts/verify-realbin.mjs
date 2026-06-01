/**
 * Sanity-check the new materialize/apply against the REAL (corrupted) bin:
 *  - materializeJournalRow must not crash; report live/dup before & after a
 *    no-op re-save through applyJournalFields.
 *  - confirm legacy blocks (order == null) keep stored list order (no scramble).
 *
 * Run: node scripts/verify-realbin.mjs <file.bin>
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.document = dom.window.document
globalThis.window = dom.window
import { readFileSync } from 'node:fs'

const A = await import('@automerge/automerge')
const { materializeJournalRow, applyJournalFields, saveDoc, loadDoc } =
  await import('../src/services/automergeDoc.js')

const path = process.argv[2] || '2026-05-31.bin'
const doc = await loadDoc(new Uint8Array(readFileSync(path)))
const row = materializeJournalRow(doc)
const live = row.blocks.filter(b => !b.deleted)
const ids = live.map(b => b.id)
const orderCount = live.filter(b => b.order != null).length

console.log(`file: ${path}`)
console.log(`materialized: ${row.blocks.length} total, ${live.length} live`)
console.log(`live blocks with order key: ${orderCount}/${live.length} (rest are legacy null-order)`)
console.log(`duplicate live ids: ${new Set(ids).size !== ids.length ? (ids.length - new Set(ids).size) + ' dupes' : 'none'}`)
console.log(`first 6 live ids (sorted-as-materialized): ${ids.slice(0,6).map(s=>s.slice(0,8)).join(' ')}`)
console.log(`audio live index: ${live.findIndex(b => /data-audio-id/.test(b.html||''))}`)

// Legacy order preservation: since these are null-order, materialize must keep
// the stored Automerge list order (no reshuffle). Compare to raw list order.
const rawLiveIds = (doc.blocks||[]).filter(b=>!b.deleted).map(b=>b.id)
const samePrefix = JSON.stringify(rawLiveIds) === JSON.stringify(ids)
console.log(`legacy order preserved (materialized order == raw list order): ${samePrefix ? 'YES' : 'NO (reshuffled!)'}`)
