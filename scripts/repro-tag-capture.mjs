/**
 * Checks for the hashtag-notes foundation (#32, split of #9):
 *   captureScopes (src/lib/hashtags.js)  — the adaptive capture rule
 *   buildTagIndex / noteDocument (src/lib/tagIndex.js) — the note's document,
 *   origin dedup across notes, alias resolution, fork-wins, hidden-drops,
 *   stored order first and new captures at the end (#48).
 *
 * Pure functions, no DOM needed. Run: node scripts/repro-tag-capture.mjs
 */
import assert from 'node:assert/strict'

const { captureScopes, captureScopesFromBlocks, canonicalTag, tagFromTitle } =
  await import('../src/lib/hashtags.js')
const { buildTagIndex, noteDocument, resolveTagNote, originOf } =
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
{
  const { headersByTag } = captureScopes([
    { id: 'h1', text: '#a #b' }, { id: 'p1', text: 'under both' },
    { id: 'gap', text: '' },
    { id: 'h2', text: '#a' },            // nothing under it
    { id: 'h3', text: '#c' }, { id: 'p2', text: 'under c' },
  ])
  assert.deepEqual([...headersByTag.entries()].sort(), [['a', ['h1']], ['b', ['h1']], ['c', ['h3']]], 'a header is reported once its scope has content')
  ok('captureScopes: headersByTag')
}
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
  const groc = noteDocument(index, [standup, groceries], 'groceries')
  assert.deepEqual(groc.map(e => e.origin), ['o1', 't1', 't2', 't3'], 'alias captures resolve; the header line shows above what it took (#48); sorted by day then order')
  assert.equal(groc[0].date, '2026-08-20')
  assert.ok(groc.every(e => e.kind === 'mirror'))
  assert.ok((index.captures.get('groceries') || []).find(c => c.blockId === 't2')?.header, 'the header capture is marked')
  assert.ok(!(index.captures.get('groceries') || []).find(c => c.blockId === 't3')?.header)
  const work = noteDocument(index, [standup, groceries], 'work')
  assert.deepEqual(work.map(e => [e.origin, e.srcType]), [['t2', 'journal'], ['t3', 'journal'], ['w1', 'journal'], ['s1', 'note']])
  assert.equal(work[3].srcId, 'n-standup')
  // A header with nothing under it is just a line that says a tag.
  const bare = buildTagIndex({ journals: [J('2026-09-08', [P('h0', 'a', '#work'), P('e0', 'b', '')])], notes: [] })
  assert.equal(bare.captures.has('work'), false)
  assert.equal(index.lastUsed.get('work'), new Date('2026-09-04T08:00:00.000Z').getTime())
  assert.equal(index.lastUsed.get('standup'), new Date('2026-09-04T08:00:00.000Z').getTime(), 'a note ranks its own tag by its edit time')
  assert.equal(resolveTagNote([standup, groceries], '#Shopping'), groceries)
  ok('buildTagIndex + noteDocument: journal + note sources, alias, ranking')
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
  const groc = noteDocument(index, [standup, groc2], 'groceries')
  assert.deepEqual(groc.map(e => [e.id, e.kind]), [['own', 'own'], ['t1', 'fork'], ['t2', 'mirror'], ['ghost', 'fork']], 'stored order, own writing included, hidden t3 dropped, the day\'s header joins its run after t1')
  assert.equal(groc[1].html.includes('(bought)'), true, 'fork content shown, not the live source')
  assert.equal(groc[1].srcType, 'journal')
  assert.equal(originOf(groc2.blocks[1]), 't1')
  ok('noteDocument: self-mention excluded, fork wins, hidden dropped, orphan fork kept, stored order')
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
  const groc = noteDocument(index, [standup2, groceries], 'groceries')
  const bt = groc.filter(e => e.origin === 'bt')
  assert.equal(bt.length, 1)
  assert.equal(bt[0].srcType, 'journal', 'the human-typed original beats the fork copy in another note')
  assert.equal(bt[0].html.includes('(moved)'), false)
  const st = noteDocument(index, [standup2, groceries], 'standup')
  assert.deepEqual(st.filter(e => e.origin === 'bt').map(e => e.kind), ['fork'])
  ok('origin identity: two tags, one copy each, fork in one note does not leak into the other')
}

{
  // #48: the note's stored order comes first and is never re-sorted; what the
  // note has placed (a mirror) shows the LIVE source; a capture the note has
  // not placed yet arrives at the END, however old its day; a mirror whose
  // source no longer captures for the tag vanishes; a mirror is not indexed.
  const M = (origin, order, src, date, text) => ({
    id: origin, order, updatedAt: '2026-09-16T10:00:00.000Z',
    html: `<p data-bid="${origin}" data-origin="${origin}" data-src="${src}" data-date="${date}" data-mirror="1">${text}</p>`,
  })
  const placed = {
    id: 'n-groc', title: 'groceries', aliases: ['shopping'], updatedAt: '2026-09-16T10:00:00.000Z',
    blocks: [
      M('t3', 'a', 'journal:2026-09-01', '2026-09-01', 'stale copy of t3'),
      P('mine', 'b', 'my own line, typed after t3', '2026-09-16T10:00:00.000Z'),
      M('t1', 'c', 'journal:2026-09-01', '2026-09-01', 'stale copy of t1'),
      M('gone', 'd', 'journal:2026-09-02', '2026-09-02', 'was captured, tag since removed'),
    ],
  }
  const index = buildTagIndex({ journals: [...journals, old], notes: [standup, placed] })
  const doc = noteDocument(index, [standup, placed], 'groceries')
  assert.deepEqual(doc.map(e => [e.id, e.kind]),
    [['t3', 'mirror'], ['mine', 'own'], ['t1', 'mirror'], ['t2', 'mirror'], ['o1', 'mirror']],
    'stored order kept (t3 before own before t1), gone dropped, the header t2 joins its day\'s run after t1 (source order), unplaced o1 from another day appended last')
  assert.equal(doc[0].html, '<p data-bid="t3">buy the team lunch</p>', 'a mirror shows the live source, not its stored copy')
  assert.equal(doc[2].html, '<p data-bid="t1">milk #groceries</p>')

  // "Edit what's in the same hashtag block in the origin → it changes in the
  // hashtag block, not another one": a new line under a header the note has
  // already placed slots in after its sibling, before the user's own writing.
  const day = J('2026-09-10', [P('h', 'a', '#groceries'), P('x1', 'b', 'apples'), P('x2', 'c', 'pears')])
  const placed2 = {
    id: 'n-groc', title: 'groceries', updatedAt: '2026-09-16T10:00:00.000Z',
    blocks: [
      M('h', 'a', 'journal:2026-09-10', '2026-09-10', '#groceries'),
      M('x1', 'b', 'journal:2026-09-10', '2026-09-10', 'apples'),
      M('x2', 'c', 'journal:2026-09-10', '2026-09-10', 'pears'),
      P('mine', 'd', 'remember the bags', '2026-09-16T10:00:00.000Z'),
    ],
  }
  const day2 = J('2026-09-10', [...day.blocks, P('x3', 'c5', 'and plums', '2026-09-17T09:00:00.000Z')])
  const next = J('2026-09-17', [P('y1', 'a', 'tomatoes #groceries', '2026-09-17T09:00:00.000Z')])
  const idx2 = buildTagIndex({ journals: [day2, next], notes: [placed2] })
  const doc2 = noteDocument(idx2, [placed2], 'groceries')
  assert.deepEqual(doc2.map(e => e.id), ['h', 'x1', 'x2', 'x3', 'mine', 'y1'],
    'x3 joins its run after pears and before own writing; a new day starts a run at the end')
  // An edited paragraph in the origin: same origin, the mirror follows — no second block.
  const day3 = J('2026-09-10', day2.blocks.map(b => b.id === 'x1' ? P('x1', 'b', 'green apples') : b))
  const doc3 = noteDocument(buildTagIndex({ journals: [day3, next], notes: [placed2] }), [placed2], 'groceries')
  assert.deepEqual(doc3.map(e => e.id), ['h', 'x1', 'x2', 'x3', 'mine', 'y1'])
  assert.match(doc3[1].html, /green apples/)
  assert.equal(doc[1].html, placed.blocks[1].html, 'own writing verbatim')
  assert.equal((index.captures.get('groceries') || []).some(c => c.srcId === 'n-groc'), false, 'mirrors are not indexed as captures')
  ok('noteDocument (#48): stored order first, mirrors live, header shown, siblings join their run, new runs append, gone mirrors vanish')
}

console.log(`\n${n} checks passed`)
