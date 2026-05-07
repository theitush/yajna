/**
 * Adds a `search-highlight` class to a single top-level block by its bid.
 * Driven by ProseMirror decorations so tiptap's own re-renders don't strip
 * the class (which is what happened when we tried to add it imperatively
 * via classList.add on the DOM node).
 *
 * Usage from a parent component:
 *   editor.commands.setSearchHighlight(bid)   // bid string or null to clear
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const KEY = new PluginKey('searchHighlight')

function buildDecorations(doc, bid) {
  if (!bid) return DecorationSet.empty
  const decos = []
  doc.descendants((node, pos, parent) => {
    if (parent !== doc) return false
    if (node.attrs?.bid === bid) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'search-highlight' }))
    }
    return false
  })
  return DecorationSet.create(doc, decos)
}

export const SearchHighlightExtension = Extension.create({
  name: 'searchHighlight',

  addCommands() {
    return {
      setSearchHighlight: (bid) => ({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(KEY, bid ?? null))
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: KEY,
        state: {
          init: () => ({ bid: null, decos: DecorationSet.empty }),
          apply(tr, prev) {
            const meta = tr.getMeta(KEY)
            const nextBid = meta === undefined ? prev.bid : meta
            if (nextBid === prev.bid && !tr.docChanged) return prev
            return { bid: nextBid, decos: buildDecorations(tr.doc, nextBid) }
          },
        },
        props: {
          decorations(state) {
            return this.getState(state).decos
          },
        },
      }),
    ]
  },
})
