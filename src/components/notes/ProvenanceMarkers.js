/**
 * What a tag-note shows about where a paragraph came from (#9, #48):
 *
 *   - every captured block (one with an `origin` attr) is shaded, whether it
 *     still mirrors its source or the note has forked it — "parts that came
 *     from a journal entry should just have the shading";
 *   - a faint marker above each run of captured blocks from one source and one
 *     day says where they came from ("Tuesday, September 15", or "from #work ·
 *     Tuesday, September 15"), fainter while the editor has focus (CSS), and
 *     switchable off entirely;
 *   - a block the note has forked additionally says "edited" (CSS ::after).
 *
 * Own writing gets none of this. Decorations, not content: nothing here is
 * part of the document, so a marker can never be typed over, serialized into
 * a block, or stored.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { formatDate } from '../../lib/dates'

const EMPTY = { show: true, forks: null, sourceLabel: null }

function markerText(src, date, sourceLabel) {
  const day = date ? formatDate(date) : ''
  const from = src && src.startsWith('note:') ? sourceLabel?.(src.slice('note:'.length)) : null
  if (from && day) return `from #${from} · ${day}`
  if (from) return `from #${from}`
  return day
}

export const ProvenanceMarkers = Extension.create({
  name: 'provenanceMarkers',

  addOptions() {
    return {
      // () => ({ show: boolean, forks: Set<origin>, sourceLabel: (noteId) => tag|null })
      // Read on every redraw, so the component can flip the toggle without
      // rebuilding the editor.
      getMarkerState: null,
    }
  },

  addProseMirrorPlugins() {
    const read = () => this.options.getMarkerState?.() || EMPTY
    return [
      new Plugin({
        key: new PluginKey('provenanceMarkers'),
        props: {
          decorations(state) {
            const { show, forks, sourceLabel } = read()
            const decorations = []
            let lastRun = null
            let pos = 0
            state.doc.forEach((node) => {
              const origin = node.attrs?.origin || null
              if (!origin) {
                lastRun = null
                pos += node.nodeSize
                return
              }
              const src = node.attrs?.src || null
              const date = node.attrs?.srcDate || null
              const run = `${src}|${date}`
              if (show && run !== lastRun) {
                const text = markerText(src, date, sourceLabel)
                if (text) {
                  decorations.push(Decoration.widget(pos, () => {
                    const el = document.createElement('div')
                    el.className = 'note-marker'
                    el.setAttribute('contenteditable', 'false')
                    el.textContent = text
                    return el
                  }, { side: -1, key: `note-marker:${run}:${origin}`, ignoreSelection: true, stopEvent: () => true }))
                }
              }
              lastRun = run
              const cls = forks?.has(origin) ? 'note-from note-edited' : 'note-from'
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }))
              pos += node.nodeSize
            })
            return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
          },
        },
      }),
    ]
  },
})

export default ProvenanceMarkers
