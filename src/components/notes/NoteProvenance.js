/**
 * Keeps a tag-note's captured blocks honest about who they are (#48).
 *
 * A captured block carries `origin` (and `src`, `srcDate`, `mirror`) as node
 * attributes, and its `bid` IS its origin. ProseMirror copies a block's attrs
 * when it splits one — Enter inside a captured paragraph makes two blocks that
 * both claim the origin — and a paste brings in a block claiming an origin this
 * note never captured. Left alone, the second would read as the captured
 * paragraph and the first as new writing, or an empty half would fork the
 * paragraph to nothing.
 *
 * So after every change: of the blocks claiming one origin, exactly one keeps
 * it — the first that has content, else the first — and the rest become own
 * writing (provenance cleared, bid cleared so BlockIdExtension mints a fresh
 * one). A block claiming an origin the document does not know (`getKnownOrigins`)
 * becomes own writing the same way. The reconcile in noteReconcile.js applies
 * the same rule to what it stores; this plugin makes the editor show it at
 * once, so the shading follows the text and not the empty line above it.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const CLEARED = { origin: null, src: null, srcDate: null, mirror: null, bid: null }

function hasContent(node) {
  if (node.type.name === 'audio') return true
  return node.textContent.trim() !== ''
}

export const NoteProvenance = Extension.create({
  name: 'noteProvenance',

  addOptions() {
    return {
      // () => Set<origin> | null — the origins the rendered document holds.
      // Null means "don't check" (only duplicates are resolved).
      getKnownOrigins: null,
    }
  },

  addProseMirrorPlugins() {
    const known = () => this.options.getKnownOrigins?.() || null
    return [
      new Plugin({
        key: new PluginKey('noteProvenance'),
        appendTransaction: (transactions, _old, newState) => {
          if (!transactions.some(tr => tr.docChanged)) return null
          const byOrigin = new Map()
          newState.doc.forEach((node, pos) => {
            const origin = node.attrs?.origin
            if (!origin) return
            const list = byOrigin.get(origin) || []
            list.push({ node, pos })
            byOrigin.set(origin, list)
          })
          if (byOrigin.size === 0) return null
          const knownSet = known()
          const tr = newState.tr
          let changed = false
          const clear = ({ node, pos }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...CLEARED })
            changed = true
          }
          for (const [origin, list] of byOrigin) {
            if (knownSet && !knownSet.has(origin)) {
              list.forEach(clear)
              continue
            }
            if (list.length < 2) continue
            const keeper = list.find(x => hasContent(x.node)) || list[0]
            for (const x of list) {
              if (x === keeper) {
                if (x.node.attrs.bid !== origin) {
                  tr.setNodeMarkup(x.pos, undefined, { ...x.node.attrs, bid: origin })
                  changed = true
                }
                continue
              }
              clear(x)
            }
          }
          return changed ? tr : null
        },
      }),
    ]
  },
})

export default NoteProvenance
