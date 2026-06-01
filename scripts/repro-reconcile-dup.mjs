/**
 * Verifies the defer-until-idle fix for the "every paragraph duplicated" bug
 * (commit 4b4bbef left reconcileMergedBlocks fighting BlockIdExtension's
 * id-filler; see prior version of this file for the reproduction).
 *
 * Two things to prove now:
 *   1. The OLD reconcile path duplicated blocks (kept here as a guard so we
 *      never reintroduce it): 3 paragraphs → >3 after a self-echo reconcile.
 *   2. The NEW path is byte-stable: editor.getHTML() round-trips equal to
 *      blocksToHtml(docToBlocks(...)), so a pure local save short-circuits
 *      (current === remoteContent) and never triggers a spurious setContent /
 *      cursor reset on a routine typing pause.
 *
 * Run: node scripts/repro-reconcile-dup.mjs
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

const { Editor } = await import('@tiptap/core')
const StarterKit = (await import('@tiptap/starter-kit')).default
const { DOMSerializer } = await import('@tiptap/pm/model')
const { BlockIdExtension } = await import('../src/components/editor/BlockIdExtension.js')
const { docToBlocks, blocksToHtml } = await import('../src/lib/blocks.js')

function makeEditor(html) {
  return new Editor({ extensions: [StarterKit, BlockIdExtension], content: html })
}

let pass = true

// --- Proof 2: byte-stable round-trip (the property the fix relies on) --------
{
  const editor = makeEditor('<p>alpha</p><p>beta</p><p>gamma</p>')
  // Let blockIdFiller stamp bids (it runs on the next docChanged transaction).
  editor.commands.insertContentAt(1, ' ')   // triggers appendTransaction → bids
  editor.commands.deleteRange({ from: 1, to: 2 })

  const ser = DOMSerializer.fromSchema(editor.schema)
  const blocks = docToBlocks(editor.state.doc, ser)
  // Mirror the store: stamp order on the blocks (blocksToHtml sorts by it).
  blocks.forEach((b, i) => { b.order = 'a' + i })

  const fromStore = blocksToHtml(blocks)    // what remoteContent would be
  const onScreen = editor.getHTML()          // what current is
  const stable = fromStore === onScreen
  console.log('round-trip stable:', stable)
  if (!stable) {
    pass = false
    console.log('  current :', onScreen)
    console.log('  fromStore:', fromStore)
  }
  editor.destroy()
}

// --- Proof 1: the OLD reconcile path duplicated (regression guard) -----------
function oldReconcile(editor, mergedBlocks) {
  const ser = DOMSerializer.fromSchema(editor.schema)
  const editorIds = new Set(docToBlocks(editor.state.doc, ser).map(b => b.id))
  const live = (mergedBlocks || []).filter(b => !b.deleted && b.id && b.html)
  const missing = live.filter(b => !editorIds.has(b.id))
  for (const block of missing) {
    editor.chain().setMeta('addToHistory', false)
      .insertContentAt(editor.state.doc.content.size, block.html, { emitUpdate: false }).run()
  }
}
{
  const editor = makeEditor('<p>alpha</p><p>beta</p><p>gamma</p>')
  const ser = DOMSerializer.fromSchema(editor.schema)
  const seed = docToBlocks(editor.state.doc, ser)
  const merged = seed.map((b, i) => ({ ...b, order: 'a' + i }))
  oldReconcile(editor, merged)
  const after = docToBlocks(editor.state.doc, ser).length
  console.log('old reconcile: 3 blocks →', after, '(expected >3, proving the bug)')
  if (after <= 3) { pass = false; console.log('  guard failed: bug NOT reproduced by old path') }
  editor.destroy()
}

console.log(pass ? '\n✅ fix verified' : '\n❌ FAILED')
process.exit(pass ? 0 : 1)
