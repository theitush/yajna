/**
 * Checks for a tag-note's document and fork rule (#34, #48, split of #9):
 *   renderNoteHtml / buildBaseline / reconcileNote / docMatchesEntries
 *   (src/components/notes/noteReconcile.js)
 *
 * The rule under test: the note is one document whose stored order is never
 * re-sorted; a captured paragraph is stored as a MIRROR (placed, still
 * following its source) the first time the note saves, becomes the note's own
 * copy (a FORK) only when the user edits it, and own writing is stored as
 * typed, where it was typed, with no provenance at all. The source doc is never
 * touched — the last group proves the journal day object is byte-identical
 * after a fork, since the whole path is pure reads.
 *
 * Pure functions, no DOM needed. Run: node scripts/repro-tag-fork.mjs
 */
import assert from 'node:assert/strict'

const {
  setBlockAttrs, stripProvenance, normalizeBlockHtml, isBlankHtml, renderNoteHtml,
  buildBaseline, reconcileNote, docMatchesEntries,
} = await import('../src/components/notes/noteReconcile.js')
const { buildTagIndex, noteDocument, isMirrorBlock, isForkBlock } = await import('../src/lib/tagIndex.js')

let n = 0
const ok = (name) => { n++; console.log('  ok', name) }

const p = (bid, text, extra = '') => `<p data-bid="${bid}"${extra}>${text}</p>`
// The editor serializes what it was given; that IS the baseline.
const docOf = (html) => html.split('</p>').filter(Boolean).map(s => {
  const full = s + '</p>'
  const bid = /data-bid="([^"]*)"/.exec(full)?.[1]
  return { id: bid, html: full }
})

// ---- attribute surgery ------------------------------------------------------
assert.equal(
  setBlockAttrs(p('b1', 'hi'), { 'data-origin': 'b1' }),
  '<p data-bid="b1" data-origin="b1">hi</p>',
)
// Idempotent: re-applying the same values returns the identical string, which
// is what keeps a stored block from churning on every render.
const once = setBlockAttrs(p('b1', 'hi'), { 'data-origin': 'b1', 'data-date': '2026-09-01' })
assert.equal(setBlockAttrs(once, { 'data-origin': 'b1', 'data-date': '2026-09-01' }), once)
// `false` removes; null leaves alone.
assert.equal(setBlockAttrs(once, { 'data-date': false, 'data-origin': null }), '<p data-bid="b1" data-origin="b1">hi</p>')
assert.equal(
  stripProvenance('<p data-bid="x" data-origin="o" data-src="journal:2026-09-01" data-date="2026-09-01" data-mirror="1">t</p>'),
  '<p data-bid="x">t</p>',
)
// An audio block's transcript legitimately contains '>' — the tag scan must
// honour quotes or it cuts the tag in half.
const audio = '<div data-bid="audio-1" data-audio-id="1" data-transcript="a > b">|</div>'
assert.equal(
  setBlockAttrs(audio, { 'data-origin': 'audio-1' }),
  '<div data-bid="audio-1" data-audio-id="1" data-transcript="a > b" data-origin="audio-1">|</div>',
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
ok('setBlockAttrs / stripProvenance / isBlankHtml / normalizeBlockHtml')

// ---- rendering the document ---------------------------------------------------
const own = (id, text) => ({ kind: 'own', id, origin: null, html: p(id, text), date: null, srcType: null, srcId: null })
const mirror = (origin, text, date) => ({ kind: 'mirror', id: origin, origin, html: p(origin, text), date, srcType: 'journal', srcId: date })
const fork = (origin, text, date) => ({
  kind: 'fork', id: origin, origin, date, srcType: 'journal', srcId: date,
  html: p(origin, text, ` data-origin="${origin}" data-src="journal:${date}" data-date="${date}"`),
})

const entries = [own('w1', 'my heading line'), mirror('j1', 'bread', '2026-09-01'), mirror('j2', 'milk', '2026-09-02')]
const rendered = renderNoteHtml(entries)
assert.equal(rendered.split('</p>').filter(Boolean).length, 3)
assert.match(rendered, /<p data-bid="w1">my heading line<\/p>/, 'own writing carries no provenance')
assert.match(rendered, /data-origin="j1"/)
assert.match(rendered, /data-src="journal:2026-09-01"/)
assert.match(rendered, /data-date="2026-09-02"/)
assert.equal((rendered.match(/data-mirror="1"/g) || []).length, 2, 'every unforked captured block renders as a mirror')
assert.doesNotMatch(renderNoteHtml([fork('j1', 'sourdough', '2026-09-01')]), /data-mirror/, 'a fork never carries the mirror flag')
const docBlocks = docOf(rendered)
const baseline = buildBaseline(docBlocks, entries)
assert.equal(baseline.size, 2, 'own writing has no baseline')
assert.equal(baseline.get('j1').src, 'journal:2026-09-01')
assert.equal(baseline.get('j1').isFork, false)
assert.ok(docMatchesEntries(docBlocks, entries))
// Attribute order must not read as a change.
assert.ok(docMatchesEntries(
  [docBlocks[0],
   { id: 'j1', html: '<p data-origin="j1" data-mirror="1" data-src="journal:2026-09-01" data-date="2026-09-01" data-bid="j1">bread</p>' },
   docBlocks[2]],
  entries,
))
// A different order IS a change (that is what re-renders a moved block).
assert.equal(docMatchesEntries([docBlocks[1], docBlocks[0], docBlocks[2]], entries), false)
// An empty note renders as one empty paragraph — a match, not a change.
assert.ok(docMatchesEntries([{ id: 'x', html: '<p></p>' }], []))
ok('renderNoteHtml / buildBaseline / docMatchesEntries')

// ---- an untouched document stores itself as placed, nothing forks -------------
const base = { baseline, hiddenOrigins: [] }
let r = reconcileNote({ ...base, docBlocks })
assert.deepEqual(r.blocks.map(b => b.id), ['w1', 'j1', 'j2'], 'stored in document order')
assert.equal(r.blocks[0].html, p('w1', 'my heading line'))
assert.ok(isMirrorBlock(r.blocks[1]) && isMirrorBlock(r.blocks[2]), 'captured blocks are stored as mirrors: placed, still following')
assert.ok(!isForkBlock(r.blocks[1]))
assert.deepEqual(r.hiddenOrigins, [])
ok('an untouched save places every captured block as a mirror and forks none')

// ---- editing forks, and only the edited block ---------------------------------
const edited = docBlocks.map(b => b.id === 'j1' ? { ...b, html: b.html.replace('bread', 'sourdough') } : b)
r = reconcileNote({ ...base, docBlocks: edited })
assert.deepEqual(r.blocks.map(b => b.id), ['w1', 'j1', 'j2'], 'the edited block keeps its place')
assert.ok(isForkBlock(r.blocks[1]), 'the edited block is a fork')
assert.match(r.blocks[1].html, /sourdough/)
assert.match(r.blocks[1].html, /data-origin="j1"/)
assert.match(r.blocks[1].html, /data-src="journal:2026-09-01"/)
assert.match(r.blocks[1].html, /data-date="2026-09-01"/)
assert.doesNotMatch(r.blocks[1].html, /data-mirror/)
assert.ok(isMirrorBlock(r.blocks[2]), 'its neighbour still mirrors')
ok('an edited block forks in place, its neighbour does not')

// ---- a fork the note already holds is kept, even untouched ----------------------
const heldEntries = [fork('j1', 'sourdough', '2026-09-01'), mirror('j2', 'milk', '2026-09-02')]
const heldDoc = docOf(renderNoteHtml(heldEntries))
r = reconcileNote({ baseline: buildBaseline(heldDoc, heldEntries), docBlocks: heldDoc, hiddenOrigins: [] })
assert.ok(isForkBlock(r.blocks[0]))
assert.match(r.blocks[0].html, /sourdough/)
ok('a held fork survives a save that did not touch it')

// ---- writing is just writing (#48) -----------------------------------------------
// A line typed at the end stays at the end and is own writing: no origin, so
// no shading and no "edited".
const typed = [...docBlocks, { id: 'new1', html: p('new1', 'and olive oil') }]
r = reconcileNote({ ...base, docBlocks: typed })
assert.deepEqual(r.blocks.map(b => b.id), ['w1', 'j1', 'j2', 'new1'])
assert.equal(r.blocks[3].html, p('new1', 'and olive oil'))
assert.ok(!isForkBlock(r.blocks[3]) && !isMirrorBlock(r.blocks[3]), 'typed writing carries no provenance')
// A line typed BETWEEN two captured blocks stays between them.
const between = [docBlocks[0], docBlocks[1], { id: 'mid', html: p('mid', 'note to self') }, docBlocks[2]]
r = reconcileNote({ ...base, docBlocks: between })
assert.deepEqual(r.blocks.map(b => b.id), ['w1', 'j1', 'mid', 'j2'])
// A blank line is a spacer the writer kept, stored like the journal stores one.
r = reconcileNote({ ...base, docBlocks: [...docBlocks, { id: 'sp', html: '<p data-bid="sp"></p>' }] })
assert.equal(r.blocks.length, 4)
ok('own writing is stored as typed, where it was typed, with no provenance')

// ---- the tail of a split, and a paste, are own writing --------------------------
// ProseMirror copies attrs on Enter: two blocks claim j1. The second is new
// writing under its own id; the first (unchanged) still mirrors.
const split = [docBlocks[0], docBlocks[1],
  { id: 'tail', html: setBlockAttrs(p('tail', 'and cheese'), { 'data-origin': 'j1', 'data-src': 'journal:2026-09-01', 'data-date': '2026-09-01', 'data-mirror': '1' }) },
  docBlocks[2]]
r = reconcileNote({ ...base, docBlocks: split })
assert.deepEqual(r.blocks.map(b => b.id), ['w1', 'j1', 'tail', 'j2'])
assert.equal(r.blocks[2].html, p('tail', 'and cheese'), 'the second claimant is stripped to own writing')
assert.ok(isMirrorBlock(r.blocks[1]))
// A paste from another note claims an origin this document never held.
const pasted = [...docBlocks, { id: 'copy1', html: setBlockAttrs(p('copy1', 'lunch plan'), { 'data-origin': 'zz', 'data-src': 'journal:2026-09-05', 'data-date': '2026-09-05' }) }]
r = reconcileNote({ ...base, docBlocks: pasted })
assert.equal(r.blocks[3].html, p('copy1', 'lunch plan'))
assert.deepEqual(r.hiddenOrigins, [])
ok('a split tail and a foreign paste become own writing, never a second claimant')

// ---- removing a captured block hides its origin ----------------------------------
r = reconcileNote({ ...base, docBlocks: docBlocks.filter(b => b.id !== 'j2') })
assert.deepEqual(r.hiddenOrigins, ['j2'])
assert.deepEqual(r.blocks.map(b => b.id), ['w1', 'j1'])
// An origin already hidden stays hidden; one that is back in the doc is not.
r = reconcileNote({ ...base, docBlocks, hiddenOrigins: ['j9', 'j1'] })
assert.deepEqual(r.hiddenOrigins, ['j9'])
ok('a removed block hides, a returning one un-hides')

// ---- end to end: place, fork, follow — the journal is untouched -------------------
const journal = {
  date: '2026-09-01',
  updatedAt: '2026-09-01T10:00:00.000Z',
  blocks: [
    { id: 'j1', html: p('j1', 'bread #groceries'), order: 'a0', updatedAt: '2026-09-01T10:00:00.000Z' },
    { id: 'j2', html: p('j2', 'milk #groceries'), order: 'a1', updatedAt: '2026-09-01T10:00:00.000Z' },
  ],
}
const journalBefore = JSON.stringify(journal)
const stamp = (blocks, t) => blocks.map((b, i) => ({ ...b, order: String.fromCharCode(98 + i), updatedAt: t }))
let note = { id: 'note-g', title: 'groceries', updatedAt: '2026-09-16T10:00:00.000Z', blocks: [] }
let index = buildTagIndex({ journals: [journal], notes: [note] })
let doc = noteDocument(index, [note], 'groceries')
assert.deepEqual(doc.map(e => [e.id, e.kind]), [['j1', 'mirror'], ['j2', 'mirror']])

// The user types a line at the end; the save places both captures and the line.
let dBlocks = docOf(renderNoteHtml(doc))
let saved = reconcileNote({ baseline: buildBaseline(dBlocks, doc), docBlocks: [...dBlocks, { id: 'me', html: p('me', 'also: coffee') }], hiddenOrigins: [] })
note = { ...note, blocks: stamp(saved.blocks, '2026-09-16T10:01:00.000Z') }
index = buildTagIndex({ journals: [journal], notes: [note] })
doc = noteDocument(index, [note], 'groceries')
assert.deepEqual(doc.map(e => [e.id, e.kind]), [['j1', 'mirror'], ['j2', 'mirror'], ['me', 'own']], 'the typed line is at the end and is own writing')
assert.equal(JSON.stringify(journal), journalBefore, 'the journal day is untouched')

// The journal paragraph is edited on its own page: the mirror follows.
const journal2 = { ...journal, blocks: journal.blocks.map(b => b.id === 'j2' ? { ...b, html: p('j2', 'oat milk #groceries') } : b) }
index = buildTagIndex({ journals: [journal2], notes: [note] })
doc = noteDocument(index, [note], 'groceries')
assert.match(doc[1].html, /oat milk/, 'a mirror shows the live source')
assert.equal(doc[1].kind, 'mirror')

// The user edits j1 in the note: it forks in place; j2 keeps following.
dBlocks = docOf(renderNoteHtml(doc))
saved = reconcileNote({ baseline: buildBaseline(dBlocks, doc), docBlocks: dBlocks.map(b => b.id === 'j1' ? { ...b, html: b.html.replace('bread', 'sourdough') } : b), hiddenOrigins: [] })
note = { ...note, blocks: stamp(saved.blocks, '2026-09-16T10:02:00.000Z') }
index = buildTagIndex({ journals: [journal2], notes: [note] })
doc = noteDocument(index, [note], 'groceries')
assert.deepEqual(doc.map(e => [e.id, e.kind]), [['j1', 'fork'], ['j2', 'mirror'], ['me', 'own']], 'the fork keeps its place')
assert.match(doc[0].html, /sourdough/)
assert.equal(doc[0].date, '2026-09-01', 'a fork keeps the day it was captured on')
assert.equal(JSON.stringify(journal), journalBefore, 'the journal day is still untouched')

// A new paragraph written into the SAME day's entry joins the run the note
// already holds (after j2, before the user's line); a paragraph from a new day
// starts a new run at the END, after the user's line.
const journal3 = { ...journal2, blocks: [...journal2.blocks, { id: 'j3', html: p('j3', 'eggs #groceries'), order: 'a2', updatedAt: '2026-09-17T10:00:00.000Z' }] }
const nextDay = { date: '2026-09-17', updatedAt: '2026-09-17T10:00:00.000Z', blocks: [{ id: 'k1', html: p('k1', 'tomatoes #groceries'), order: 'a0', updatedAt: '2026-09-17T10:00:00.000Z' }] }
index = buildTagIndex({ journals: [journal3, nextDay], notes: [note] })
doc = noteDocument(index, [note], 'groceries')
assert.deepEqual(doc.map(e => e.id), ['j1', 'j2', 'j3', 'me', 'k1'], 'a same-day sibling joins its run; a new day appends; nothing sorts into the middle')

// Hiding j2 empties it from the note; the journal still has it.
dBlocks = docOf(renderNoteHtml(doc))
saved = reconcileNote({ baseline: buildBaseline(dBlocks, doc), docBlocks: dBlocks.filter(b => b.id !== 'j2'), hiddenOrigins: [] })
note = { ...note, blocks: stamp(saved.blocks, '2026-09-16T10:03:00.000Z'), hiddenOrigins: saved.hiddenOrigins }
index = buildTagIndex({ journals: [journal3, nextDay], notes: [note] })
doc = noteDocument(index, [note], 'groceries')
assert.deepEqual(doc.map(e => e.id), ['j1', 'j3', 'me', 'k1'])
assert.equal(JSON.stringify(journal), journalBefore, 'the journal day is still untouched')
ok('place → fork in place → follow the source → sibling joins its run, new day at the end → hide; journal unchanged throughout')

console.log(`\n${n} check groups green`)
