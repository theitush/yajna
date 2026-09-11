/**
 * Keeps the selection off an audio clip.
 *
 * A clip is an ATOM node, so a NodeSelection on it makes the clip itself the
 * selected range — and ProseMirror's default text input REPLACES the selected
 * range. Appending a clip at the end of the document leaves exactly that
 * selection (there is no text position after a trailing atom), so the first
 * character typed after a recording deletes the recording. That is the
 * "recorded something, typed right after, the recording disappeared" report;
 * scripts/repro-audio-typed-over.mjs proves both the loss and this fix.
 *
 * The fix normalises the selection when it is SET rather than when a key
 * arrives. The previous guard relocated the caret from handleKeyDown /
 * handleTextInput, which only ever worked on a desktop keyboard: Android soft
 * keyboards report `key: 'Unidentified'` (keyCode 229) and deliver the
 * character through an IME DOM diff that never reaches handleTextInput, so on
 * the phone — the one place this was reported — nothing relocated the caret.
 * Doing it in appendTransaction is input-path independent: by the time any
 * character arrives, from any keyboard, the selection is already a caret after
 * the clip and there is no selected node left to replace.
 */
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@tiptap/pm/state'

export const audioSelectionKey = new PluginKey('audioSelection')

export function audioSelectionPlugin({ nodeName = 'audio', isEditable = () => true } = {}) {
  return new Plugin({
    key: audioSelectionKey,
    appendTransaction: (_transactions, _oldState, newState) => {
      // A read-only editor (Review, Trash) can't be typed into, so there is
      // nothing to protect — and appending a paragraph there would mutate a
      // document the user only opened to look at.
      if (!isEditable()) return null
      const sel = newState.selection
      if (!(sel instanceof NodeSelection) || sel.node?.type?.name !== nodeName) return null

      const after = sel.to
      const tr = newState.tr
      const $after = newState.doc.resolve(after)
      // A trailing clip has nowhere to put the caret — give it a paragraph to
      // land in, which is where the user is about to type anyway.
      if ($after.parent.type.name === 'doc' && !$after.nodeAfter) {
        const para = newState.schema.nodes.paragraph?.create()
        if (!para) return null
        tr.insert(after, para)
        return tr.setSelection(TextSelection.create(tr.doc, after + 1))
      }
      try {
        return tr.setSelection(TextSelection.near(tr.doc.resolve(after), 1))
      } catch {
        return null
      }
    },
  })
}
