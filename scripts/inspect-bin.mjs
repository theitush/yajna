import { readFileSync } from 'node:fs'
import * as Automerge from '@automerge/automerge'

const path = process.argv[2]
if (!path) { console.error('usage: inspect-bin.mjs <file>'); process.exit(1) }
const doc = Automerge.load(new Uint8Array(readFileSync(path)))
const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()

const blocks = doc.blocks || []
const live = blocks.filter(b => !b.deleted)
const dead = blocks.filter(b => b.deleted)

// id-shape classification
const shape = (id) => {
  if (!id) return 'null'
  if (id.startsWith('empty-')) return 'empty-N'
  if (/^c[0-9a-z]{1,8}$/.test(id)) return 'content-hash'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)) return 'uuid'
  return 'other'
}

const dist = {}
for (const b of live) { const s = shape(b.id); dist[s] = (dist[s] || 0) + 1 }

// duplicate detection — same id appearing more than once among LIVE blocks,
// and near-dup detection (same stripped text, different id).
const byId = new Map()
for (const b of live) byId.set(b.id, (byId.get(b.id) || 0) + 1)
const dupIds = [...byId.entries()].filter(([, n]) => n > 1)

const byText = new Map()
for (const b of live) {
  const t = stripHtml(b.html)
  if (!t) continue
  if (!byText.has(t)) byText.set(t, [])
  byText.get(t).push(b.id)
}
const dupText = [...byText.entries()].filter(([, ids]) => ids.length > 1)

const isAudio = (b) => /data-audio-id/.test(b.html || '')
const audioPositions = live.map((b, i) => isAudio(b) ? i : -1).filter(i => i >= 0)

console.log('file:', path)
console.log('total blocks:', blocks.length, '| live:', live.length, '| tombstoned:', dead.length)
console.log('live id-shape distribution:', dist)
console.log('audio block positions (live index):', audioPositions)
console.log('duplicate LIVE ids (id appears >1x):', dupIds.length ? dupIds : 'none')
console.log('near-dup LIVE blocks (same text, different id):', dupText.length)
if (dupText.length) {
  for (const [t, ids] of dupText.slice(0, 12)) {
    console.log(`   "${t.slice(0, 50)}" -> ${JSON.stringify(ids)}`)
  }
  if (dupText.length > 12) console.log(`   ...and ${dupText.length - 12} more`)
}
console.log('\nfirst 20 live blocks (id [shape] : text):')
for (const b of live.slice(0, 20)) {
  console.log(`  ${b.id} [${shape(b.id)}]${isAudio(b) ? ' [AUDIO]' : ''} : ${stripHtml(b.html).slice(0, 60)}`)
}
