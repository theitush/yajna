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
            // INVARIANT: every top-level block carries a stable, globally-unique
            // bid for its entire life. This is the sole source of block identity
            // for sync/merge (src/lib/blocks.js, services/automergeDoc.js): the
            // Automerge block list is reconciled by id, so a block that ever
            // changes (or loses) its id reads as a brand-new block and gets
            // APPENDED rather than updated in place — duplicating it across
            // devices. This applies to EVERY block type:
            //   - content paragraphs/headings (obvious),
            //   - atoms like audio/horizontalRule (no text, but a real clip with
            //     identity — must not be re-minted each serialization), and
            //   - empty paragraphs (blank spacer lines the user keeps between
            //     entries — they're list elements too, so an id-less / positional
            //     blank forks on merge → the duplicate-blank-rows bug).
            // So: assign an id to any block lacking one (or colliding with an
            // earlier block, e.g. the new half of an Enter split), and never
            // strip an existing id.
            //
            // Audio blocks derive their id deterministically from the clip id
            // (audio-<clipId>) so the SAME clip has the SAME block identity no
            // matter which path created it (live insert here vs restore via
            // audioBlockHtml). The two must agree or a clip + its restored twin
            // would merge as two blocks.
            const desired = node.type.name === 'audio' && node.attrs?.audioId
              ? `audio-${node.attrs.audioId}`
              : null
            if (desired) {
              if (bid !== desired) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, bid: desired })
                changed = true
              }
              seen.add(desired)
            } else if (!bid || seen.has(bid)) {
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
