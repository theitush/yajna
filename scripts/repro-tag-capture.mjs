/**
 * Checks for the hashtag-notes foundation (#32, split of #9):
 *   captureScopes (src/lib/hashtags.js)  — the adaptive capture rule
 *   buildTagIndex / noteStream (src/lib/tagIndex.js) — the derived stream,
 *   origin dedup across notes, alias resolution, fork-wins, hidden-drops.
 *
 * Pure functions, no DOM needed. Run: node scripts/repro-tag-capture.mjs
 */
import assert from 'node:assert/strict'

const { captureScopes, captureScopesFromBlocks, canonicalTag, tagFromTitle } =
  await import('../src/lib/hashtags.js')
const { buildTagIndex, noteStream, resolveTagNote, originOf } =
  await import('../src/lib/tagIndex.js')

let n = 0
const ok = (name) => { n++; console.log('  ok', name) }

// ---- canonical forms --------------------------------------------------------
assert.equal(canonicalTag('#Groceries'), 'groceries')
assert.equal(canonicalTag('  GROCERIES '), 'groceries')
assert.equal(canonicalTag('daily standup'), null)
assert.equal(canonicalTag(''), null)
assert.equal(canonicalTag('פזו'), 'פזו')
assert.equal(tagFromTitle('Daily standup'), 'daily-standup')
assert.equal(tagFromTitle('  Q3 -- plans!  '), 'q3-plans')
assert.equal(tagFromTitle('***'), null)
ok('canonicalTag / tagFromTitle')

// ---- capture rule -----------------------------------------------------------
{
  const items = [
    { id: 'a', text: 'bought milk #groceries and eggs' },      // inline
    { id: 'h', text: '#work #standup' },                       // header
    { id: 'b', text: 'shipped the sync fix' },                 // under header
    { id: 'c', text: 'talked to Dana about #groceries' },      // under header + inline
    { id: 'e', text: '' },                                     // terminator
    { id: 'd', text: 'not captured by anything' },
    { id: 'h2', text: '#ideas' },                              // header, then next header
    { id: 'h3', text: '#music' },
    { id: 'f', text: 'listen to the new record' },
  ]
  const { byBlock, byTag, headers } = captureScopes(items)
  assert.deepEqual(byBlock.get('a'), ['groceries'])
  assert.deepEqual(byBlock.get('b'), ['work', 'standup'])
  assert.deepEqual(byBlock.get('c').sort(), ['groceries', 'standup', 'work'])
  assert.equal(byBlock.has('d'), false)
  assert.equal(byBlock.has('h'), false, 'header line is not content')
  assert.equal(byBlock.has('e'), false)
  assert.deepEqual(byTag.get('groceries'), ['a', 'c'])
  assert.deepEqual(byTag.get('work'), ['b', 'c'])
  assert.equal(byTag.has('ideas'), false, 'a header immediately followed by another captures nothing')
  assert.deepEqual(byTag.get('music'), ['f'])
  assert.deepEqual([...headers].sort(), ['h', 'h2', 'h3'])
  ok('captureScopes: inline, header, header+inline, blank terminator, back-to-back headers')
}
{
  // Stored blocks: order key decides the sequence, tombstones are skipped,
  // an untranscribed clip under a header is content (not a terminator), and
  // a spoken #tag in a transcript captures the clip.
  const blocks = [
    { id: 'p2', order: 'b', html: '<p data-bid="p2">second line</p>' },
    { id: 'h', order: 'a', html: '<p data-bid="h">#voice</p>' },
    { id: 'gone', order: 'a5', deleted: true, html: '<p data-bid="gone">#never</p>' },
    { id: 'audio-1', order: 'c', html: '<div data-bid="audio-1" data-audio-id="1"></div>' },
    { id: 'p3', order: 'd', html: '<p data-bid="p3">third</p>' },
    { id: 'audio-2', order: 'e', html: '<div data-bid="audio-2" data-audio-id="2" data-transcript="remember #groceries milk"></div>' },
  ]
  const { byTag } = captureScopesFromBlocks(blocks)
  assert.deepEqual(byTag.get('voice'), ['p2', 'audio-1', 'p3', 'audio-2'])
  assert.deepEqual(byTag.get('groceries'), ['audio-2'])
  assert.equal(byTag.has('never'), false)
  ok('captureScopesFromBlocks: order key, tombstones, audio clips')
}

// ---- index + stream -----------------------------------------------------------
const J = (date, blocks, updatedAt = `${date}T10:00:00.000Z`) => ({ date, updatedAt, blocks })
const P = (id, order, text, updatedAt = '2026-09-01T10:00:00.000Z') =>
  ({ id, order, updatedAt, html: `<p data-bid="${id}">${text}</p>` })

const journals = [
  J('2026-09-01', [P('t1', 'a', 'milk #groceries'), P('t2', 'b', '#work #groceries'), P('t3', 'c', 'buy the team lunch')]),
  J('2026-09-03', [P('w1', 'a', 'sprint review #work', '2026-09-03T09:00:00.000Z')]),
]
const standup = {
  id: 'n-standup', title: 'standup', updatedAt: '2026-09-04T08:00:00.000Z',
  blocks: [P('s1', 'a', 'blocked on #work item', '2026-09-04T08:00:00.000Z')],
}
const groceries = { id: 'n-groc', title: 'groceries', aliases: ['shopping'], updatedAt: '2026-09-02T08:00:00.000Z', blocks: [] }
const old = J('2026-08-20', [P('o1', 'a', 'old list #shopping', '2026-08-20T10:00:00.000Z')])

{
  const index = buildTagIndex({ journals: [...journals, old], notes: [standup, groceries] })
  const groc = noteStream(index, [standup, groceries], 'groceries')
  assert.deepEqual(groc.map(e => e.origin), ['o1', 't1', 't3'], 'alias captures resolve; header line excluded; sorted by day then order')
  assert.equal(groc[0].date, '2026-08-20')
  assert.ok(groc.every(e => !e.isFork))
  const work = noteStream(index, [standup, groceries], 'work')
  assert.deepEqual(work.map(e => [e.origin, e.srcType]), [['t3', 'journal'], ['w1', 'journal'], ['s1', 'note']])
  assert.equal(work[2].srcId, 'n-standup')
  assert.equal(index.lastUsed.get('work'), new Date('2026-09-04T08:00:00.000Z').getTime())
  assert.equal(index.lastUsed.get('standup'), new Date('2026-09-04T08:00:00.000Z').getTime(), 'a note ranks its own tag by its edit time')
  assert.equal(resolveTagNote([standup, groceries], '#Shopping'), groceries)
  ok('buildTagIndex + noteStream: journal + note sources, alias, ranking')
}

{
  // A note never captures its own tag from itself; a fork the note holds wins
  // over the live source; a hidden origin is dropped; a fork outlives its origin.
  const groc2 = {
    ...groceries,
    hiddenOrigins: ['t3'],
    blocks: [
      P('own', 'a', 'standing list: eggs, #groceries'),                       // own body mentioning own tag
      { id: 't1', order: 'b', updatedAt: '2026-09-05T00:00:00.000Z',
        html: '<p data-bid="t1" data-origin="t1" data-src="journal:2026-09-01" data-date="2026-09-01">milk (bought) #groceries</p>' },
      { id: 'ghost', order: 'c', updatedAt: '2026-09-05T00:00:00.000Z',
        html: '<p data-bid="ghost" data-origin="ghost" data-src="journal:2026-07-01" data-date="2026-07-01">from a paragraph since deleted</p>' },
    ],
  }
  const index = buildTagIndex({ journals, notes: [standup, groc2] })
  assert.equal((index.captures.get('groceries') || []).some(c => c.srcId === 'n-groc'), false, 'own-tag mention is just text')
  const groc = noteStream(index, [standup, groc2], 'groceries')
  assert.deepEqual(groc.map(e => [e.origin, e.isFork]), [['ghost', true], ['t1', true]])
  assert.equal(groc[1].html.includes('(bought)'), true, 'fork content shown, not the live source')
  assert.equal(groc[1].srcType, 'journal')
  assert.equal(originOf(groc2.blocks[1]), 't1')
  ok('noteStream: self-mention excluded, fork wins, hidden dropped, orphan fork kept')
}

{
  // Note-to-note capture settles in one round: a paragraph mentioning two tags
  // ends up once in each note; a fork of it in #standup that still mentions
  // #groceries does not duplicate the original in #groceries.
  const bothTags = J('2026-09-06', [P('bt', 'a', 'lunch plan #standup #groceries', '2026-09-06T10:00:00.000Z')])
  const standup2 = {
    ...standup,
    blocks: [...standup.blocks, { id: 'bt', order: 'b', updatedAt: '2026-09-07T00:00:00.000Z',
      html: '<p data-bid="bt" data-origin="bt" data-src="journal:2026-09-06" data-date="2026-09-06">lunch plan (moved) #standup #groceries</p>' }],
  }
  const index = buildTagIndex({ journals: [...journals, bothTags], notes: [standup2, groceries] })
  const groc = noteStream(index, [standup2, groceries], 'groceries')
  const bt = groc.filter(e => e.origin === 'bt')
  assert.equal(bt.length, 1)
  assert.equal(bt[0].srcType, 'journal', 'the human-typed original beats the fork copy in another note')
  assert.equal(bt[0].html.includes('(moved)'), false)
  const st = noteStream(index, [standup2, groceries], 'standup')
  assert.deepEqual(st.filter(e => e.origin === 'bt').map(e => e.isFork), [true])
  ok('origin identity: two tags, one copy each, fork in one note does not leak into the other')
}

console.log(`\n${n} checks passed`)
