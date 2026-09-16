/**
 * Faint day markers for a tag-note's stream, and the "edited" mark on the
 * blocks the note holds its own copy of (#9: markers are faint, fade further
 * while you're editing — that part is CSS on .ProseMirror-focused — and can be
 * switched off entirely).
 *
 * Decorations, not content: nothing here is part of the document, so a marker
 * can never be typed over, serialized into a block, or stored.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { formatDate } from '../../lib/dates'

const EMPTY = { show: true, forks: null }

export const StreamDateMarkers = Extension.create({
  name: 'streamDateMarkers',

  addOptions() {
    return {
      // () => ({ show: boolean, forks: Set<origin> }) — read on every redraw,
      // so the component can flip the toggle without rebuilding the editor.
      getMarkerState: null,
    }
  },

  addProseMirrorPlugins() {
    const read = () => this.options.getMarkerState?.() || EMPTY
    return [
      new Plugin({
        key: new PluginKey('streamDateMarkers'),
        props: {
          decorations(state) {
            const { show, forks } = read()
            const decorations = []
            let lastDate = null
            let pos = 0
            state.doc.forEach((node) => {
              const date = node.attrs?.srcDate || null
              const origin = node.attrs?.origin || node.attrs?.bid || null
              if (show && date && date !== lastDate) {
                decorations.push(Decoration.widget(pos, () => {
                  const el = document.createElement('div')
                  el.className = 'stream-date-marker'
                  el.setAttribute('contenteditable', 'false')
                  el.textContent = formatDate(date)
                  return el
                }, { side: -1, key: `stream-date:${date}`, ignoreSelection: true, stopEvent: () => true }))
              }
              if (date) lastDate = date
              if (show && origin && forks?.has(origin)) {
                decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'stream-edited' }))
              }
              pos += node.nodeSize
            })
            return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
          },
        },
      }),
    ]
  },
})

export default StreamDateMarkers
