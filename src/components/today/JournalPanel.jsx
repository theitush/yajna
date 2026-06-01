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

    // Defer until the editor is idle (no pending local save). While the user is
    // actively typing, do NOT touch the editor: a setContent mid-type resets the
    // cursor, and any incremental insert fights BlockIdExtension's id-filler,
    // which re-ids the inserted blocks as duplicates → the doubled-paragraph bug.
    // The merged blocks are already safe in the store (currentDay); we just defer
    // RENDERING them until typing pauses, when this effect re-runs (the local
    // save bumped currentDay → remoteContent) and the editor is clear to reset.
    // TipTap's setContent does its own cursor-free DOM reconciliation, so a clean
    // reset is the right primitive here — no hand-rolled position math.
    if (saveTimeout.current) return
    editor.commands.setContent(remoteContent, { emitUpdate: false })
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
