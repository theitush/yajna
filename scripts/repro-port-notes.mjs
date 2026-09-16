/**
 * Checks for the pre-bijection note port (#35): proposals, live validation,
 * collisions among rows and with existing tag-notes, and that Apply is gated.
 * Run: node scripts/repro-port-notes.mjs
 */
import assert from 'node:assert/strict'
const { needsTag, noteLabel, proposeTag, planPort } = await import('../src/components/notes/portNotes.js')

const P = (id, text) => ({ id, order: 'a', html: `<p data-bid="${id}">${text}</p>` })
const notes = [
  { id: 'ok', title: 'groceries', blocks: [] },                                   // already a tag
  { id: 'a', title: 'Daily standup', blocks: [] },
  { id: 'b', title: 'daily  standup', blocks: [] },                               // slugs to the same tag as `a`
  { id: 'c', title: '', blocks: [P('c1', 'Groceries for the week: milk, eggs')] },  // empty title → first line → collides with `ok`
  { id: 'd', title: '***', blocks: [] },                                          // nothing tag-like
  { id: 'e', title: 'Q3 plans!', blocks: [] },
]
const pending = notes.filter(needsTag)
assert.deepEqual(pending.map(n => n.id), ['a', 'b', 'c', 'd', 'e'])
assert.equal(noteLabel(notes[3]), 'Groceries for the week: milk, eggs')
assert.equal(noteLabel(notes[4]), '***')
assert.equal(proposeTag(notes[1]), 'daily-standup')
assert.equal(proposeTag(notes[3]), 'groceries-for-the-week-milk-eggs')
assert.equal(proposeTag(notes[4]), '')
console.log('  ok needsTag / noteLabel / proposeTag')

let plan = planPort(pending, notes)
const by = (rows) => Object.fromEntries(rows.map(r => [r.id, r.problem]))
assert.deepEqual(by(plan.rows), {
  a: 'used twice here', b: 'used twice here', c: null, d: 'not a tag', e: null,
})
assert.equal(plan.ready, false)
console.log('  ok collisions among rows flag both, empty proposal flagged, Apply blocked')

plan = planPort(pending, notes, { b: 'standup-notes', c: 'groceries', d: 'misc' })
assert.deepEqual(by(plan.rows), { a: null, b: null, c: '#groceries already has a note', d: null, e: null })
assert.equal(plan.ready, false)
console.log('  ok collision with an existing tag-note flagged, resolved rows clear')

plan = planPort(pending, notes, { b: 'standup-notes', c: 'Weekly Shop', d: 'misc' })
assert.equal(plan.rows[2].problem, 'not a tag', 'a typed value with a space is refused, same as the + input')
plan = planPort(pending, notes, { b: 'standup-notes', c: '#Weekly-Shop', d: 'misc' })
assert.deepEqual(plan.rows.map(r => r.tag), ['daily-standup', 'standup-notes', 'weekly-shop', 'misc', 'q3-plans'])
assert.equal(plan.ready, true)
console.log('  ok all rows valid and unique → ready (a leading # and capitals are canonicalised)')

// A former name still resolves: after the port, `resolveTagNote` finds the
// note by its new title, and the old free-text title is kept on `formerTitle`
// by the caller (updateNote passes unknown fields through).
const after = notes.map(n => n.id === 'a' ? { ...n, title: 'daily-standup', formerTitle: 'Daily standup' } : n)
assert.equal(planPort(after.filter(needsTag), after).rows.some(r => r.id === 'a'), false, 'ported note leaves the banner')
console.log('  ok ported note drops out of pending')

console.log('\n5 check groups green')
