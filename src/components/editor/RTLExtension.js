import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const HEBREW_RE = /[\u0590-\u05FF]/
const BLOCK_TYPES = ['paragraph', 'heading']

/**
 * 1. Extends paragraph + heading schemas with a `dir` attribute.
 * 2. Renders dir="rtl" / dir="ltr" on those nodes.
 * 3. appendTransaction: auto-sets dir based on first character.
 */
export const RTLExtension = Extension.create({
  name: 'rtlDetect',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          dir: {
            default: null,
            parseHTML: el => el.getAttribute('dir') || null,
            renderHTML: attrs => (attrs.dir ? { dir: attrs.dir } : {}),
          },
        },
      },
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('rtl-detect'),
        appendTransaction(_transactions, _oldState, newState) {
          const tr = newState.tr
          let changed = false

          newState.doc.descendants((node, pos) => {
            if (!BLOCK_TYPES.includes(node.type.name)) return
            const text = node.textContent
            const first = text.trimStart()[0] || ''
            const shouldRTL = HEBREW_RE.test(first)
            const currentDir = node.attrs.dir

            const wantDir = shouldRTL ? 'rtl' : null
            if (currentDir !== wantDir) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, dir: wantDir })
              changed = true
            }
          })

          return changed ? tr : null
        },
      }),
    ]
  },
})
