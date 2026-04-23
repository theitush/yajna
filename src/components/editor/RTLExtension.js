import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const HEBREW_RE = /[\u0590-\u05FF]/
const BLOCK_TYPES = ['paragraph', 'heading']

/**
 * Get the first meaningful character in a text node,
 * skipping leading numbers, hyphens, bullets, whitespace, punctuation, etc.
 */
function getFirstMeaningfulChar(text) {
  // Skip leading: whitespace, digits, hyphens, bullets, common punctuation
  const leadingRe = /^[\s\d\u002D\u2022\u2023\u25E6\u2043\u2219\u002B\u002A\u002E\u002C\u003A\u003B\u0021\u003F\u0022\u0027\u0028\u0029\u005B\u005D\u007B\u007D\u003C\u003E]*[^\s\d\u002D\u2022\u2023\u25E6\u2043\u2219\u002B\u002A\u002E\u002C\u003A\u003B\u0021\u003F\u0022\u0027\u0028\u0029\u005B\u005D\u007B\u007D\u003C\u003E]/
  const match = text.match(leadingRe)
  if (match && match[0]) {
    return match[0][match[0].length - 1] || ''
  }
  return ''
}

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
            const first = getFirstMeaningfulChar(text.trimStart())
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
