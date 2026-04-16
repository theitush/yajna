import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useEffect, useCallback, useRef } from 'react'
import useAppStore from '../../store/useAppStore'
import { today, weekKey, formatDate } from '../../lib/dates'
import VoiceButton from '../voice/VoiceButton'
import EditorToolbar from '../editor/EditorToolbar'
import { RTLExtension } from '../editor/RTLExtension'

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
  const saveTimeout = useRef(null)
  const todayStr = today()

  useEffect(() => {
    loadJournal(weekKey(todayStr))
  }, [])

  const content = currentJournal?.entries?.[todayStr]?.content || ''

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      HashtagExtension,
      RTLExtension,
    ],
    content,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        updateJournalEntry(todayStr, html)
      }, 800)
    },
  })

  const remoteContent = currentJournal?.entries?.[todayStr]?.content
  useEffect(() => {
    if (!editor || !remoteContent) return
    const current = editor.getHTML()
    if (current !== remoteContent) {
      editor.commands.setContent(remoteContent, false)
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
        <VoiceButton onTranscription={(text) => onInsertText?.current?.(text)} />
      </div>

      <EditorToolbar editor={editor} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        <EditorContent editor={editor} style={{ height: '100%' }} />
      </div>
    </div>
  )
}
