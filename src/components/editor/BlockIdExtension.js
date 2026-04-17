/**
 * Attaches a stable `data-bid` uuid attribute to every top-level block node
 * (paragraph, heading, list, audio, ...). Enables block-level sync/merge:
 * see src/lib/blocks.js. Without stable ids, every save would look like
 * "all blocks changed" and merging would lose data on concurrent edits.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { v4 as uuid } from 'uuid'

const ATTR = 'data-bid'

export const BlockIdExtension = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    // Which top-level node types should carry a block id. Covers the block
    // nodes used in journal/notes editors.
    const types = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule', 'audio']
    return [
      {
        types,
        attributes: {
          bid: {
            default: null,
            parseHTML: el => el.getAttribute(ATTR),
            renderHTML: attrs => attrs.bid ? { [ATTR]: attrs.bid } : {},
          },
          conflict: {
            default: null,
            parseHTML: el => el.getAttribute('data-conflict'),
            renderHTML: attrs => attrs.conflict ? { 'data-conflict': attrs.conflict } : {},
          },
        },
      },
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockIdFiller'),
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some(tr => tr.docChanged)) return null
          const tr = newState.tr
          const seen = new Set()
          let changed = false
          newState.doc.descendants((node, pos, parent) => {
            // Only top-level blocks (direct children of the doc).
            if (parent !== newState.doc) return
            const bid = node.attrs?.bid
            if (!bid || seen.has(bid)) {
              // Missing, or duplicated by a split/paste → assign fresh id.
              const fresh = uuid()
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, bid: fresh })
              seen.add(fresh)
              changed = true
            } else {
              seen.add(bid)
            }
            return false
          })
          return changed ? tr : null
        },
      }),
    ]
  },
})
