import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer } from '@tiptap/pm/model'
import { useEffect, useCallback, useRef } from 'react'
import useAppStore from '../../store/useAppStore'
import { today, weekKey, formatDate } from '../../lib/dates'
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

export default function JournalPanel({ onInsertText }) {
  const currentJournal = useAppStore(s => s.currentJournal)
  const updateJournalEntry = useAppStore(s => s.updateJournalEntry)
  const loadJournal = useAppStore(s => s.loadJournal)
  const getTags = useAppStore.getState().getAllTags
  const saveTimeout = useRef(null)
  const todayStr = today()

  useEffect(() => {
    loadJournal(weekKey(todayStr))
  }, [])

  const todayEntry = currentJournal?.entries?.[todayStr]
  const content = (todayEntry?.content ?? blocksToHtml(todayEntry?.blocks)) || ''

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
          sourceId: todayStr,
          sourceTitle: formatDate(todayStr),
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
        updateJournalEntry(todayStr, { html, blocks })
      }, 800)
    },
  })

  const remoteEntry = currentJournal?.entries?.[todayStr]
  const remoteContent = remoteEntry?.content ?? blocksToHtml(remoteEntry?.blocks)
  useEffect(() => {
    if (!editor || !remoteContent) return
    // Don't overwrite the editor if there's a pending local save —
    // the user is actively typing and we'd clobber their changes
    if (saveTimeout.current) return
    const current = editor.getHTML()
    if (current !== remoteContent) {
      editor.commands.setContent(remoteContent, { emitUpdate: false })
    }
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
          {formatDate(todayStr)}
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
