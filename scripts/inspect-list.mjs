import { readFileSync } from 'node:fs'
import * as Automerge from '@automerge/automerge'

const doc = Automerge.load(new Uint8Array(readFileSync(process.argv[2])))
const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
const blocks = doc.blocks || []

// Show the raw list in order, marking live/dead, with a short id + text.
// Detect: does the same id appear at multiple LIST positions (live)?
const liveSeen = new Map()
console.log(`raw list length: ${blocks.length}`)
console.log('idx  L/D  id(8)     text')
let firstDupBoundary = -1
blocks.forEach((b, i) => {
  const tag = b.deleted ? 'D' : 'L'
  const short = (b.id || 'null').slice(0, 8)
  if (!b.deleted) {
    if (liveSeen.has(b.id) && firstDupBoundary < 0) firstDupBoundary = i
    liveSeen.set(b.id, (liveSeen.get(b.id) || 0) + 1)
  }
})
// print a window around the first duplicate boundary
const lo = Math.max(0, firstDupBoundary - 3)
const hi = Math.min(blocks.length, firstDupBoundary + 6)
console.log(`\nfirst live-dup boundary at list index ${firstDupBoundary}; window [${lo},${hi}):`)
for (let i = lo; i < hi; i++) {
  const b = blocks[i]
  console.log(`${String(i).padStart(3)}  ${b.deleted ? 'D' : 'L'}   ${(b.id||'null').slice(0,8)}  ${stripHtml(b.html).slice(0,45)}`)
}

// Also: are the duplicated entries adjacent runs or interleaved? Show the
// live-only sequence of short ids to eyeball the repeat structure.
const liveIds = blocks.filter(b => !b.deleted).map(b => (b.id||'null').slice(0,6))
console.log('\nlive id sequence (6-char):')
console.log(liveIds.join(' '))
