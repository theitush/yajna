import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useEffect, useCallback, useRef } from 'react'
import useAppStore from '../../store/useAppStore'
import { today, weekKey, formatDate } from '../../lib/dates'
import VoiceButton from '../voice/VoiceButton'

/**
 * Custom TipTap extension to highlight #hashtags inline
 */
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
            const regex = /#[\w\u0590-\u05FF]+/g // includes Hebrew chars
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
      HashtagExtension,
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

  // Re-set content when journal loads
  useEffect(() => {
    if (!editor || !currentJournal) return
    const entry = currentJournal.entries?.[todayStr]
    if (!entry) return
    const current = editor.getHTML()
    if (current !== entry.content) {
      editor.commands.setContent(entry.content, false)
    }
  }, [currentJournal?.week])

  // Expose insert method to parent
  useEffect(() => {
    if (!onInsertText) return
    onInsertText.current = (text) => {
      if (!editor) return
      editor.commands.focus()
      editor.commands.insertContent(text)
    }
  }, [editor, onInsertText])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {formatDate(todayStr)}
        </h2>
        <VoiceButton onTranscription={(text) => onInsertText?.current?.(text)} />
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-gray-800 dark:text-gray-200">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  )
}
