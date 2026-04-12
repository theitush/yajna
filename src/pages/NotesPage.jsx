import { useState, useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import useAppStore from '../store/useAppStore'

const HashtagExtension = Extension.create({
  name: 'hashtag',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('hashtag-notes'),
      props: {
        decorations(state) {
          const { doc } = state
          const decorations = []
          const regex = /#[\w\u0590-\u05FF]+/g
          doc.descendants((node, pos) => {
            if (!node.isText) return
            let match
            while ((match = regex.exec(node.text)) !== null) {
              decorations.push(Decoration.inline(pos + match.index, pos + match.index + match[0].length, { class: 'hashtag' }))
            }
          })
          return DecorationSet.create(doc, decorations)
        },
      },
    })]
  },
})

function extractTags(text) {
  const matches = text.match(/#[\w\u0590-\u05FF]+/g) || []
  return [...new Set(matches.map(t => t.slice(1)))]
}

function NoteEditor({ note, onUpdate, onDelete }) {
  const saveTimeout = { current: null }

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Write your note…' }),
      HashtagExtension,
    ],
    content: note?.body || '',
    onUpdate: ({ editor }) => {
      const body = editor.getHTML()
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        const tags = extractTags(editor.getText())
        onUpdate(note.id, { body, tags })
      }, 800)
    },
  })

  useEffect(() => {
    if (!editor || !note) return
    const current = editor.getHTML()
    if (current !== note.body) {
      editor.commands.setContent(note.body || '', false)
    }
  }, [note?.id])

  if (!note) return (
    <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
      Select a note or create a new one
    </div>
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">{note.title}</span>
        <button
          onClick={() => onDelete(note.id)}
          className="text-xs text-red-400 hover:text-red-600 px-2 py-1"
        >
          Delete
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-gray-800 dark:text-gray-200">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

export default function NotesPage() {
  const notes = useAppStore(s => s.notes)
  const addNote = useAppStore(s => s.addNote)
  const updateNote = useAppStore(s => s.updateNote)
  const deleteNote = useAppStore(s => s.deleteNote)
  const [selectedTag, setSelectedTag] = useState(null)
  const [selectedNoteId, setSelectedNoteId] = useState(null)
  const [mobileView, setMobileView] = useState('list') // 'list' | 'editor'

  // Collect all unique tags
  const allTags = [...new Set(notes.flatMap(n => n.tags || []))].sort()

  const filteredNotes = selectedTag
    ? notes.filter(n => n.tags?.includes(selectedTag))
    : notes

  const selectedNote = notes.find(n => n.id === selectedNoteId) || null

  const handleNew = async () => {
    const note = await addNote('', selectedTag ? [selectedTag] : [])
    setSelectedNoteId(note.id)
    setMobileView('editor')
  }

  const handleSelect = (id) => {
    setSelectedNoteId(id)
    setMobileView('editor')
  }

  const handleDelete = async (id) => {
    await deleteNote(id)
    setSelectedNoteId(null)
    setMobileView('list')
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Tags sidebar */}
      <div className={`w-36 shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col ${mobileView !== 'list' ? 'hidden md:flex' : 'flex'}`}>
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tags</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <button
            onClick={() => setSelectedTag(null)}
            className={`w-full text-left px-3 py-2 text-xs transition-colors ${
              selectedTag === null
                ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            All notes
          </button>
          {allTags.map(tag => (
            <button
              key={tag}
              onClick={() => setSelectedTag(tag)}
              className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                selectedTag === tag
                  ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>
      </div>

      {/* Notes list */}
      <div className={`w-48 md:w-56 shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col ${mobileView !== 'list' ? 'hidden md:flex' : 'flex'}`}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Notes</span>
          <button
            onClick={handleNew}
            className="text-xs px-2 py-1 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
          >
            +
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredNotes.length === 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500 px-3 py-4">No notes yet</p>
          )}
          {filteredNotes.map(note => (
            <button
              key={note.id}
              onClick={() => handleSelect(note.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 transition-colors ${
                note.id === selectedNoteId
                  ? 'bg-violet-50 dark:bg-violet-900/30'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{note.title || 'Untitled'}</p>
              {note.tags?.length > 0 && (
                <p className="text-xs text-violet-500 mt-0.5 truncate">
                  {note.tags.map(t => `#${t}`).join(' ')}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className={`flex-1 flex flex-col overflow-hidden ${mobileView !== 'editor' ? 'hidden md:flex' : 'flex'}`}>
        {mobileView === 'editor' && (
          <button
            onClick={() => setMobileView('list')}
            className="md:hidden text-left px-4 py-2 text-xs text-violet-600 dark:text-violet-400 border-b border-gray-200 dark:border-gray-700"
          >
            ← Back
          </button>
        )}
        <NoteEditor
          key={selectedNoteId}
          note={selectedNote}
          onUpdate={updateNote}
          onDelete={handleDelete}
        />
      </div>
    </div>
  )
}
