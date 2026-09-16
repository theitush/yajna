/**
 * The hashtag layer, shared by every editor that writes tags (the journal
 * today, notes next). It draws two things and owns no state of its own:
 *
 *   1. the tags themselves — an inline `.hashtag` decoration over every
 *      HASHTAG_RE match, so a tag is visibly a tag as you type it;
 *   2. what each tag is TAKING — node decorations from `captureScopes`
 *      (src/lib/hashtags.js): `.tag-captured` + `data-captured-by="a b"` on
 *      every block a tag captures, `.tag-header` on a tag-only line that
 *      opens a scope.
 *
 * (2) is Ita's review note on #9 — "the hashtag should maybe just show what
 * its taking.. make it adaptive. it would sorta shade the paragraph it
 * applies to.. or a lil frame. so maybe no need for the selector". There is
 * deliberately no capture-mode setting: the rule adapts to how the tag was
 * written and the frame shows the writer the result live. Decorations are
 * rebuilt from the doc on every change, so the frame appears on the keystroke
 * that finishes a tag and is gone on the one that breaks it — nothing to
 * invalidate, nothing to keep in sync.
 *
 * The capture rule lives in `captureScopes` and ONLY there: this file maps a
 * ProseMirror doc onto its `{ id, text, empty }` items and paints the answer.
 * The stored-blocks path (`captureScopesFromBlocks`) feeds the same function,
 * so what the editor frames and what the tag index collects cannot drift.
 *
 * Decorations never reach the document: `getHTML()` / `docToBlocks` serialize
 * `state.doc`, not the view's DOM, so none of these classes are ever saved or
 * synced.
 *
 * Usage:
 *   HashtagExtension.configure({ onTagClick: tag => navigate(`/notes?tag=${tag}`) })
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { HASHTAG_RE, canonicalTag, captureScopes } from '../../lib/hashtags.js'

const KEY = new PluginKey('hashtag')

/**
 * Top-level nodes as capture items, in display order. A block's identity is
 * its `bid` (BlockIdExtension); a block that hasn't been stamped yet falls
 * back to its position, which is unique within this doc and is all we need —
 * these ids never leave this function.
 *
 * An audio clip contributes its transcript and is explicitly `empty: false`:
 * a clip is content, so it must never terminate a header's scope, and a
 * spoken "#tag" captures exactly like a written one. Matches how
 * captureScopesFromBlocks treats a stored clip.
 */
function captureItems(doc) {
  const items = []
  const blocks = []
  doc.forEach((node, offset) => {
    const isAudio = node.type.name === 'audio'
    const id = node.attrs?.bid || `@pos-${offset}`
    items.push({
      id,
      text: isAudio ? (node.attrs?.transcript || '') : node.textContent,
      empty: isAudio ? false : undefined,
    })
    blocks.push({ id, from: offset, to: offset + node.nodeSize })
  })
  return { items, blocks }
}

function buildDecorations(doc) {
  const decos = []

  // (1) the tags. HASHTAG_RE is the one regex — the editor highlights exactly
  // what captureScopes/extractHashtags will read, which the old local copy
  // (Latin word-chars plus the Hebrew block, hard-coded) did not: it missed
  // every other script and disagreed about `-`.
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const m of node.text.matchAll(HASHTAG_RE)) {
      decos.push(
        Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: 'hashtag' })
      )
    }
  })

  // (2) what they take.
  const { items, blocks } = captureItems(doc)
  const { byBlock, headers } = captureScopes(items)
  for (const b of blocks) {
    // A header is the label of a scope, not a member of it — captureScopes
    // never puts one in byBlock, so these two branches are exclusive.
    if (headers.has(b.id)) {
      decos.push(Decoration.node(b.from, b.to, { class: 'tag-header' }))
      continue
    }
    const tags = byBlock.get(b.id)
    if (tags && tags.length) {
      decos.push(
        Decoration.node(b.from, b.to, {
          class: 'tag-captured',
          'data-captured-by': tags.join(' '),
        })
      )
    }
  }

  return DecorationSet.create(doc, decos)
}

export const HashtagExtension = Extension.create({
  name: 'hashtag',

  addOptions() {
    return {
      // onTagClick: (tag) => void — canonical tag (lowercase, no `#`).
      // Omitted, tags are still drawn but inert.
      onTagClick: null,
    }
  },

  addProseMirrorPlugins() {
    // The live options object: `setOptions` mutates it, so reading a field at
    // click time picks up a reconfigure without rebuilding the plugin.
    const options = this.options
    return [
      new Plugin({
        key: KEY,
        // Rebuild only when the doc actually changed. Every other transaction
        // (selection, focus, the 1s sync poll's re-renders) reuses the set,
        // which is what keeps this off the typing path.
        state: {
          init: (_, state) => buildDecorations(state.doc),
          apply: (tr, prev) => (tr.docChanged ? buildDecorations(tr.doc) : prev),
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
          /**
           * A tag is a link-like affordance, so a click/tap on one opens its
           * note. We ask the DOM whether the hit landed on a `.hashtag` span
           * rather than doing position math, because the browser's own hit
           * testing is exactly the question being asked — and it gets the
           * edges right: a tap in the empty space after a trailing tag lands
           * on the paragraph, so it places the caret and doesn't navigate.
           * On Android the tap arrives here as a normal click, the same path
           * tiptap's own link extension uses.
           */
          handleClick(view, pos, event) {
            const onTagClick = options.onTagClick
            if (typeof onTagClick !== 'function') return false
            const target = event.target
            const el = target instanceof Element ? target.closest('.hashtag') : null
            if (!el || !view.dom.contains(el)) return false
            const tag = canonicalTag(el.textContent)
            if (!tag) return false
            event.preventDefault()
            onTagClick(tag)
            return true
          },
        },
      }),
    ]
  },
})

export default HashtagExtension
