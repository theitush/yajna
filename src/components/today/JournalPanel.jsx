import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer } from '@tiptap/pm/model'
import { useEffect, useRef } from 'react'
import useAppStore from '../../store/useAppStore'
import { formatDate, currentJournalDay } from '../../lib/dates'
import EditorToolbar from '../editor/EditorToolbar'
import { RTLExtension } from '../editor/RTLExtension'
import { AudioNode } from '../editor/AudioNode'
import { BlockIdExtension } from '../editor/BlockIdExtension'
import { HashtagSuggest } from '../editor/HashtagSuggest'
import { HeadingNoShortcut } from '../editor/HeadingNoShortcut'
import RecordFab from '../voice/RecordFab'
import { docToBlocks, blocksToHtml } from '../../lib/blocks'

const HashtagExtension = Extension.create({
  name: 'hashtag',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('hashtag'),
        props: {
          decorations(state) {
            const { doc } = state
            const decorations = []
            const regex = /#[\w\u0590-\u05FF]+/g
            doc.descendants((node, pos) => {
              if (!node.isText) return
              let match
              while ((match = regex.exec(node.text)) !== null) {
                decorations.push(
                  Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
                    class: 'hashtag',
                  })
                )
              }
            })
            return DecorationSet.create(doc, decorations)
          },
        },
      }),
    ]
  },
})

/**
 * Incrementally fold sync-merged blocks into a live (actively-edited) editor
 * without a full setContent (which would reset the cursor mid-type).
 *
 * `mergedBlocks` is the day's blocks from the store (already sorted by `order`,
 * may include tombstones). We insert only the LIVE blocks whose id isn't already
 * in the editor, each positioned after the nearest preceding block the editor
 * does have (so order matches the merged sequence), else at the document end.
 *
 * Insertions go through editor.commands so BlockIdExtension stamps/keeps the
 * bid; `emitUpdate: false` avoids re-triggering the save loop. Tombstoned blocks
 * are ignored — the user's own deletes win locally and propagate on their save.
 */
function reconcileMergedBlocks(editor, mergedBlocks) {
  const serializer = DOMSerializer.fromSchema(editor.schema)
  const editorBlocks = docToBlocks(editor.state.doc, serializer)
  const editorIds = new Set(editorBlocks.map(b => b.id))

  const live = (mergedBlocks || []).filter(b => !b.deleted && b.id && b.html)
  // Nothing new to add (a merge that only touched existing blocks is handled by
  // the per-field LWW on the next idle setContent — we don't fight the cursor).
  const missing = live.filter(b => !editorIds.has(b.id))
  if (missing.length === 0) return

  // Map each top-level editor node to its document position so we can insert
  // after the right one. Positions shift as we insert, so recompute per insert
  // by tracking offset growth — simplest correct approach: insert from the doc
  // end backwards isn't possible (we need "after X"), so we re-derive positions
  // each iteration against the live doc.
  for (const block of missing) {
    // Find the merged-sequence predecessor that the editor currently has.
    const idxInMerged = live.findIndex(b => b.id === block.id)
    let anchorId = null
    for (let j = idxInMerged - 1; j >= 0; j--) {
      if (editorIds.has(live[j].id)) { anchorId = live[j].id; break }
    }

    // Resolve the insert position from the live doc each time.
    let insertPos = null // null → append at end
    if (anchorId) {
      let acc = 0
      editor.state.doc.forEach((node) => {
        const start = acc
        acc += node.nodeSize
        if (node.attrs?.bid === anchorId) insertPos = start + node.nodeSize
      })
    }

    const chain = editor.chain().setMeta('addToHistory', false)
    if (insertPos == null) {
      chain.insertContentAt(editor.state.doc.content.size, block.html, { emitUpdate: false })
    } else {
      chain.insertContentAt(insertPos, block.html, { emitUpdate: false })
    }
    chain.run()
    editorIds.add(block.id)
  }
}

export default function JournalPanel({ onInsertText, date, headerLabel }) {
  const currentDay = useAppStore(s => s.currentDay)
  const updateJournalEntry = useAppStore(s => s.updateJournalEntry)
  const loadJournal = useAppStore(s => s.loadJournal)
  const config = useAppStore(s => s.config)
  const getTags = useAppStore.getState().getAllTags
  const saveTimeout = useRef(null)
  const targetDate = date || currentJournalDay(config)

  useEffect(() => {
    loadJournal(targetDate)
  }, [targetDate])

  const dayDoc = currentDay?.date === targetDate ? currentDay : null
  const content = (dayDoc ? blocksToHtml(dayDoc.blocks) : '') || ''

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      HashtagExtension,
      HashtagSuggest.configure({ getTags }),
      RTLExtension,
      AudioNode.configure({
        getSource: () => ({
          sourceType: 'journal',
          sourceId: targetDate,
          sourceTitle: formatDate(targetDate),
        }),
      }),
      BlockIdExtension,
    ],
    content,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      const serializer = DOMSerializer.fromSchema(editor.schema)
      const blocks = docToBlocks(editor.state.doc, serializer)
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        saveTimeout.current = null
        updateJournalEntry(targetDate, { html, blocks })
      }, 800)
    },
  })

  const remoteContent = dayDoc ? blocksToHtml(dayDoc.blocks) : ''
  useEffect(() => {
    if (!editor || !remoteContent) return
    const current = editor.getHTML()
    if (current === remoteContent) return

    if (!saveTimeout.current) {
      // Idle (no pending local save): safe to reconcile the whole doc. This
      // also restores cursor-free reload on day-switch / first load.
      editor.commands.setContent(remoteContent, { emitUpdate: false })
      return
    }

    // The user is actively typing (pending save). A full setContent here would
    // reset their cursor and clobber the in-flight edit — that's the typing-lag
    // bug. But a background sync may have merged in blocks from another device
    // that the editor doesn't have; if we do nothing, the next save's snapshot
    // omits them and stampBlocksFromDoc tombstones them (cross-device block
    // loss). So reconcile INCREMENTALLY: insert only the merged-in blocks the
    // editor is missing, at their sorted position, without touching the blocks
    // the user is editing. O(new blocks); no cursor disruption.
    reconcileMergedBlocks(editor, dayDoc?.blocks || [])
    // Intentionally keyed on remoteContent only: dayDoc.blocks is read inside but
    // remoteContent (derived from those blocks) is what should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, remoteContent])

  useEffect(() => {
    if (!onInsertText) return
    onInsertText.current = (text) => {
      if (!editor) return
      editor.commands.focus()
      editor.commands.insertContent(text)
    }
  }, [editor, onInsertText])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)' }}>
          {headerLabel ?? formatDate(targetDate)}
        </span>
      </div>

      <EditorToolbar editor={editor} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 22rem' }}>
        <EditorContent editor={editor} />
      </div>
      {editor && <RecordFab editor={editor} />}
    </div>
  )
}
