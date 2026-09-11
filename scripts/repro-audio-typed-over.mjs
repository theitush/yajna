/**
 * Repro: "recorded something, typed right after, the recording disappeared."
 *
 * Reproduces the editor-side loss proven from the 2026-09-11 phone synclog
 * (journal went 751 -> 322 chars, 3 blocks -> 2, via the editor's OWN debounced
 * save — so the audio node was deleted inside the editor, not by a sync merge).
 *
 * The audio node is an atom. RecordFab appends it with
 * `chain().focus('end').insertAudio(...)`, which leaves a NodeSelection ON the
 * atom (there is no text position after a trailing atom). ProseMirror's default
 * text input over a NodeSelection REPLACES the selected node — so the first
 * character typed deletes the clip.
 *
 * AudioNode's plugin tries to dodge that by relocating the caret in
 * handleKeyDown, but it only fires for `event.key.length === 1`. Android soft
 * keyboards report `key: 'Unidentified'` (keyCode 229), so the guard never runs
 * on the phone — which is exactly where this was reported.
 *
 * Run: node scripts/repro-audio-typed-over.mjs
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.DOMParser = dom.window.DOMParser
globalThis.Node = dom.window.Node
globalThis.Element = dom.window.Element
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Event = dom.window.Event
globalThis.getComputedStyle = dom.window.getComputedStyle
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

const { Editor, Node: TipTapNode, mergeAttributes } = await import('@tiptap/core')
const { default: Document } = await import('@tiptap/extension-document')
const { default: Paragraph } = await import('@tiptap/extension-paragraph')
const { default: Text } = await import('@tiptap/extension-text')
const { NodeSelection, TextSelection } = await import('@tiptap/pm/state')

// Schema-faithful stand-in for src/components/editor/AudioNode.jsx: same
// group/atom/selectable/draggable flags, same data-audio-id round trip. The
// React node view is irrelevant to selection semantics, so it is omitted.
const Audio = TipTapNode.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes: () => ({ audioId: { default: null } }),
  parseHTML: () => [{ tag: 'div[data-audio-id]' }],
  renderHTML: ({ HTMLAttributes, node }) =>
    ['div', mergeAttributes(HTMLAttributes, { 'data-audio-id': node.attrs.audioId })],
  addCommands() {
    return { insertAudio: (attrs) => ({ commands }) => commands.insertContent({ type: 'audio', attrs }) }
  },
})

const editor = new Editor({
  element: document.body,
  extensions: [Document, Paragraph, Text, Audio],
  content: '<p>typed before the clip</p>',
})

// --- what RecordFab.handleStop does on stop -------------------------------
editor.chain().focus('end').insertAudio({ audioId: 'clip-1' }).run()

const sel = editor.state.selection
console.log('after insertAudio:')
console.log('  html        :', editor.getHTML())
console.log('  selection   :', sel.constructor.name)
console.log('  on audio?   :', sel instanceof NodeSelection && sel.node?.type.name === 'audio')

// --- AudioNode's guard, as it fires on a desktop vs an Android keyboard ----
const isPrintable = (key) => key.length === 1
console.log('\nAudioNode handleKeyDown guard `event.key.length === 1`:')
console.log("  desktop  key='a'            -> relocates caret:", isPrintable('a'))
console.log("  Android  key='Unidentified' -> relocates caret:", isPrintable('Unidentified'))

// --- does the first typed character survive? ------------------------------
// This is `deflt()` in prosemirror-view: `view.state.tr.insertText(text)`,
// which inserts over the CURRENT selection range — the whole atom.
function typeOneChar(ed) {
  ed.view.dispatch(ed.state.tr.insertText('a'))
  return ed.getHTML()
}

console.log('\nBEFORE the fix — typing one char with the clip node-selected:')
const before = typeOneChar(editor)
console.log('  html        :', before)
const lostBefore = !before.includes('data-audio-id="clip-1"')
console.log('  clip survived:', !lostBefore)
editor.destroy()

// --- the same flow, with the real guard installed -------------------------
const { audioSelectionPlugin } = await import('../src/components/editor/audioSelection.js')

const GuardedAudio = Audio.extend({
  addProseMirrorPlugins() {
    const ed = this.editor
    return [audioSelectionPlugin({ nodeName: this.name, isEditable: () => !ed || ed.isEditable })]
  },
})

const fixed = new Editor({
  element: document.body,
  extensions: [Document, Paragraph, Text, GuardedAudio],
  content: '<p>typed before the clip</p>',
})
fixed.chain().focus('end').insertAudio({ audioId: 'clip-1' }).run()

const selAfter = fixed.state.selection
console.log('\nAFTER the fix — same insert:')
console.log('  selection   :', selAfter.constructor.name)
console.log('  on audio?   :', selAfter instanceof NodeSelection && selAfter.node?.type.name === 'audio')

const after = typeOneChar(fixed)
console.log('  html        :', after)
const lostAfter = !after.includes('data-audio-id="clip-1"')
console.log('  clip survived:', !lostAfter)

// The guard must be inert where the user is only looking (Review, Trash).
const readOnly = new Editor({
  element: document.body,
  extensions: [Document, Paragraph, Text, GuardedAudio],
  content: '<p>x</p><div data-audio-id="clip-2"></div>',
  editable: false,
})
const roBefore = readOnly.getHTML()
let audioPos = null
readOnly.state.doc.descendants((n, pos) => { if (n.type.name === 'audio') audioPos = pos })
readOnly.commands.setNodeSelection(audioPos)
const roAfter = readOnly.getHTML()
console.log('\nread-only editor untouched by the guard:', roBefore === roAfter)

const pass = lostBefore && !lostAfter && roBefore === roAfter
console.log(pass
  ? '\nPASS: repro reproduced the loss, and the guard prevents it.'
  : '\nFAIL: ' + JSON.stringify({ lostBefore, lostAfter, readOnlyUntouched: roBefore === roAfter }))
fixed.destroy()
readOnly.destroy()
process.exit(pass ? 0 : 1)
