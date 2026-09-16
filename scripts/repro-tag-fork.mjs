/**
 * Checks for the tag-note stream's fork rule (#34, split of #9):
 *   reconcileStream / renderStreamHtml / streamMatchesEntries
 *   (src/components/notes/streamFork.js)
 *
 * The rule under test: a streamed paragraph is stored ONLY once the user edits
 * it in the note, the note's own copy is keyed by the origin block id, and the
 * source doc is never touched — the last group proves the journal day object is
 * byte-identical after a fork, since the whole path is pure reads.
 *
 * Pure functions, no DOM needed. Run: node scripts/repro-tag-fork.mjs
 */
import assert from 'node:assert/strict'

const {
  setBlockAttrs, normalizeBlockHtml, isBlankHtml, renderStreamHtml,
  buildBaseline, reconcileStream, streamMatchesEntries,
} = await import('../src/components/notes/streamFork.js')
const { buildTagIndex, noteStream } = await import('../src/lib/tagIndex.js')

let n = 0
const ok = (name) => { n++; console.log('  ok', name) }

const p = (bid, text, extra = '') => `<p data-bid="${bid}"${extra}>${text}</p>`

// ---- attribute surgery ------------------------------------------------------
assert.equal(
  setBlockAttrs(p('b1', 'hi'), { 'data-origin': 'b1' }),
  '<p data-bid="b1" data-origin="b1">hi</p>',
)
// Idempotent: re-applying the same values returns the identical string, which
// is what keeps a stored fork from churning on every render.
const once = setBlockAttrs(p('b1', 'hi'), { 'data-origin': 'b1', 'data-date': '2026-09-01' })
assert.equal(setBlockAttrs(once, { 'data-origin': 'b1', 'data-date': '2026-09-01' }), once)
// An audio block's transcript legitimately contains '>' — the tag scan must
// honour quotes or it cuts the tag in half.
const audio = '<div data-bid="audio-1" data-audio-id="1" data-transcript="a > b">|</div>'
assert.equal(
  setBlockAttrs(audio, { 'data-origin': 'audio-1' }),
  '<div data-bid="audio-1" data-audio-id="1" data-transcript="a &gt; b" data-origin="audio-1">|</div>'
    .replace('a &gt; b', 'a > b'),
)
assert.equal(isBlankHtml('<p data-bid="x"></p>'), true)
assert.equal(isBlankHtml('<p data-bid="x">  </p>'), true)
assert.equal(isBlankHtml(audio), false)
assert.equal(isBlankHtml(p('x', 'word')), false)
// Comparison form: same attributes, any order.
assert.equal(
  normalizeBlockHtml('<p data-origin="o" data-bid="b">x</p>'),
  normalizeBlockHtml('<p data-bid="b" data-origin="o">x</p>'),
)
ok('setBlockAttrs / isBlankHtml / normalizeBlockHtml')

// ---- rendering the stream ---------------------------------------------------
const entries = [
  { origin: 'j1', html: p('j1', 'bread'), date: '2026-09-01', srcType: 'journal', srcId: '2026-09-01', order: 'a0', isFork: false },
  { origin: 'j2', html: p('j2', 'milk'), date: '2026-09-02', srcType: 'journal', srcId: '2026-09-02', order: 'a1', isFork: false },
]
const rendered = renderStreamHtml(entries)
assert.match(rendered, /data-origin="j1"/)
assert.match(rendered, /data-src="journal:2026-09-01"/)
assert.match(rendered, /data-date="2026-09-02"/)
// The stream editor serializes what it was given; that IS the baseline.
const docOf = (html) => html.split('</p>').filter(Boolean).map(s => {
  const full = s + '</p>'
  const bid = /data-bid="([^"]*)"/.exec(full)?.[1]
  return { id: bid, html: full }
})
const docBlocks = docOf(rendered)
const baseline = buildBaseline(docBlocks, entries)
assert.equal(baseline.size, 2)
assert.equal(baseline.get('j1').src, 'journal:2026-09-01')
assert.equal(baseline.get('j1').isFork, false)
assert.ok(streamMatchesEntries(docBlocks, entries))
// Attribute order must not read as a change.
assert.ok(streamMatchesEntries(
  [{ id: 'j1', html: '<p data-origin="j1" data-src="journal:2026-09-01" data-date="2026-09-01" data-bid="j1">bread</p>' },
   docBlocks[1]],
  entries,
))
// An empty stream renders as one empty paragraph — a match, not a change.
assert.ok(streamMatchesEntries([{ id: 'x', html: '<p></p>' }], []))
ok('renderStreamHtml / buildBaseline / streamMatchesEntries')

// ---- nothing is stored until it is edited -----------------------------------
const base = { baseline, noteId: 'note-g', today: '2026-09-16', hiddenOrigins: [] }
let r = reconcileStream({ ...base, docBlocks })
assert.deepEqual(r.forkBlocks, [])
assert.deepEqual(r.hiddenOrigins, [])
ok('an untouched stream stores nothing')

// ---- editing forks, and only the edited block --------------------------------
const edited = docBlocks.map(b => b.id === 'j1'
  ? { ...b, html: b.html.replace('bread', 'sourdough') }
  : b)
r = reconcileStream({ ...base, docBlocks: edited })
assert.equal(r.forkBlocks.length, 1)
assert.equal(r.forkBlocks[0].id, 'j1')
assert.match(r.forkBlocks[0].html, /sourdough/)
assert.match(r.forkBlocks[0].html, /data-origin="j1"/)
assert.match(r.forkBlocks[0].html, /data-src="journal:2026-09-01"/)
assert.match(r.forkBlocks[0].html, /data-date="2026-09-01"/)
assert.deepEqual(r.hiddenOrigins, [])
ok('an edited block forks, its neighbour does not')

// ---- a fork the note already holds is kept, even untouched --------------------
const heldEntries = [
  { ...entries[0], html: p('j1', 'sourdough', ' data-origin="j1" data-src="journal:2026-09-01" data-date="2026-09-01"'), isFork: true },
  entries[1],
]
const heldDoc = docOf(renderStreamHtml(heldEntries))
const heldBaseline = buildBaseline(heldDoc, heldEntries)
r = reconcileStream({ baseline: heldBaseline, docBlocks: heldDoc, noteId: 'note-g', today: '2026-09-16', hiddenOrigins: [] })
assert.equal(r.forkBlocks.length, 1)
assert.equal(r.forkBlocks[0].id, 'j1')
assert.match(r.forkBlocks[0].html, /sourdough/)
ok('a held fork survives a save that did not touch it')

// ---- removing a streamed block hides its origin -------------------------------
r = reconcileStream({ ...base, docBlocks: docBlocks.filter(b => b.id !== 'j2') })
assert.deepEqual(r.hiddenOrigins, ['j2'])
assert.deepEqual(r.forkBlocks, [])
// An origin already hidden stays hidden; one that is back in the doc is not.
r = reconcileStream({ ...base, docBlocks, hiddenOrigins: ['j9', 'j1'] })
assert.deepEqual(r.hiddenOrigins, ['j9'])
ok('a removed block hides, a returning one un-hides')

// ---- writing straight into the stream ------------------------------------------
const typed = [...docBlocks, { id: 'new1', html: p('new1', 'and olive oil') }]
r = reconcileStream({ ...base, docBlocks: typed })
assert.equal(r.forkBlocks.length, 1)
assert.equal(r.forkBlocks[0].id, 'new1')
assert.match(r.forkBlocks[0].html, /data-origin="new1"/)
assert.match(r.forkBlocks[0].html, /data-src="note:note-g"/)
assert.match(r.forkBlocks[0].html, /data-date="2026-09-16"/)
// A blank new block is not writing.
r = reconcileStream({ ...base, docBlocks: [...docBlocks, { id: 'new2', html: '<p data-bid="new2"></p>' }] })
assert.deepEqual(r.forkBlocks, [])
ok('a paragraph typed into the stream is stored under its own origin')

// ---- a pasted copy keeps its own identity ---------------------------------------
const pasted = [...docBlocks, { id: 'copy1', html: setBlockAttrs(p('copy1', 'bread'), { 'data-origin': 'j1', 'data-src': 'journal:2026-09-01', 'data-date': '2026-09-01' }) }]
r = reconcileStream({ ...base, docBlocks: pasted })
assert.equal(r.forkBlocks.length, 1)
assert.equal(r.forkBlocks[0].id, 'copy1', 'the paste becomes its own origin, not a second j1')
assert.deepEqual(r.hiddenOrigins, [])
ok('a pasted stream block does not collide with the origin it came from')

// ---- end to end: the fork wins in the stream, the journal is untouched ----------
const journal = {
  date: '2026-09-01',
  updatedAt: '2026-09-01T10:00:00.000Z',
  blocks: [{ id: 'j1', html: p('j1', 'bread #groceries'), order: 'a0', updatedAt: '2026-09-01T10:00:00.000Z' }],
}
const journalBefore = JSON.stringify(journal)
const note = {
  id: 'note-g', title: 'groceries', updatedAt: '2026-09-16T10:00:00.000Z',
  blocks: [],
}
let index = buildTagIndex({ journals: [journal], notes: [note] })
let stream = noteStream(index, [note], 'groceries')
assert.equal(stream.length, 1)
assert.equal(stream[0].isFork, false)
assert.match(stream[0].html, /bread/)

// The user edits it in the note; only the note row changes.
const forked = reconcileStream({
  baseline: buildBaseline(docOf(renderStreamHtml(stream)), stream),
  docBlocks: docOf(renderStreamHtml(stream)).map(b => ({ ...b, html: b.html.replace('bread', 'sourdough') })),
  noteId: note.id,
  today: '2026-09-16',
  hiddenOrigins: [],
})
const noteAfter = { ...note, blocks: forked.forkBlocks.map((b, i) => ({ ...b, order: `b${i}`, updatedAt: '2026-09-16T10:01:00.000Z' })) }
index = buildTagIndex({ journals: [journal], notes: [noteAfter] })
stream = noteStream(index, [noteAfter], 'groceries')
assert.equal(stream.length, 1, 'one entry per origin — the fork replaces the source, never doubles it')
assert.equal(stream[0].origin, 'j1')
assert.equal(stream[0].isFork, true)
assert.match(stream[0].html, /sourdough/)
assert.equal(stream[0].date, '2026-09-01', 'a fork keeps the day it was captured on')
assert.equal(JSON.stringify(journal), journalBefore, 'the journal day is untouched')

// Hiding it empties the stream; the journal still has it.
const hidden = { ...noteAfter, blocks: [], hiddenOrigins: ['j1'] }
index = buildTagIndex({ journals: [journal], notes: [hidden] })
assert.equal(noteStream(index, [hidden], 'groceries').length, 0)
assert.equal(JSON.stringify(journal), journalBefore, 'the journal day is still untouched')
ok('fork → stream shows the note copy, journal day unchanged')

console.log(`\n${n} check groups green`)
