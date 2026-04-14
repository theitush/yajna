import { useState, useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import useAppStore from '../store/useAppStore'
import EditorToolbar from '../components/editor/EditorToolbar'
import { RTLExtension } from '../components/editor/RTLExtension'

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
      Underline,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      HashtagExtension,
      RTLExtension,
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
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: '13px' }}>
      Select a note or create a new one
    </div>
  )

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px', borderBottom: '1px solid var(--border-light)',
      }}>
        <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {note.title || 'Untitled'}
        </span>
        <button
          onClick={() => onDelete(note.id)}
          style={{
            fontSize: '12px', color: '#FCA5A5',
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '4px 8px', fontFamily: 'var(--font-body)',
            transition: 'color 0.15s',
          }}
        >
          Delete
        </button>
      </div>
      <EditorToolbar editor={editor} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', fontSize: '14px', color: 'var(--text-primary)' }}>
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
  const [mobileView, setMobileView] = useState('list')

  const allTags = [...new Set(notes.flatMap(n => n.tags || []))].sort()
  const filteredNotes = selectedTag ? notes.filter(n => n.tags?.includes(selectedTag)) : notes
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

  const sidebarItemStyle = (isActive) => ({
    width: '100%', textAlign: 'left',
    padding: '8px 12px', fontSize: '12px',
    background: isActive ? 'var(--bg-secondary)' : 'transparent',
    borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: 'none', cursor: 'pointer',
    transition: 'all 0.15s',
  })

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Tags sidebar */}
      <div style={{
        width: '130px', flexShrink: 0,
        borderRight: '1px solid var(--border-light)',
        display: 'flex', flexDirection: 'column',
      }} className={mobileView !== 'list' ? 'hidden md:flex' : ''}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-light)' }}>
          <span style={{ fontSize: '10px', fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Tags
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <button onClick={() => setSelectedTag(null)} style={sidebarItemStyle(selectedTag === null)}>
            All notes
          </button>
          {allTags.map(tag => (
            <button key={tag} onClick={() => setSelectedTag(tag)} style={sidebarItemStyle(selectedTag === tag)}>
              #{tag}
            </button>
          ))}
        </div>
      </div>

      {/* Notes list */}
      <div style={{
        width: '180px', flexShrink: 0,
        borderRight: '1px solid var(--border-light)',
        display: 'flex', flexDirection: 'column',
      }} className={mobileView !== 'list' ? 'hidden md:flex' : ''}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', borderBottom: '1px solid var(--border-light)',
        }}>
          <span style={{ fontSize: '10px', fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Notes
          </span>
          <button
            onClick={handleNew}
            style={{
              fontSize: '14px', color: 'var(--accent)',
              background: 'var(--accent-light)',
              border: 'none', width: '22px', height: '22px',
              borderRadius: '6px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-body)',
            }}
          >
            +
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filteredNotes.length === 0 && (
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '12px' }}>No notes yet</p>
          )}
          {filteredNotes.map(note => (
            <button
              key={note.id}
              onClick={() => handleSelect(note.id)}
              style={{
                width: '100%', textAlign: 'left',
                padding: '10px 12px',
                borderBottom: '1px solid var(--border-light)',
                background: note.id === selectedNoteId ? 'var(--bg-secondary)' : 'transparent',
                borderLeft: note.id === selectedNoteId ? '2px solid var(--accent)' : '2px solid transparent',
                border: 'none', cursor: 'pointer',
                transition: 'background 0.15s',
              }}
            >
              <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {note.title || 'Untitled'}
              </p>
              {note.tags?.length > 0 && (
                <p style={{ fontSize: '11px', color: 'var(--accent)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {note.tags.map(t => `#${t}`).join(' ')}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} className={mobileView !== 'editor' ? 'hidden md:flex' : ''}>
        {mobileView === 'editor' && (
          <button
            onClick={() => setMobileView('list')}
            style={{
              textAlign: 'left', padding: '8px 16px', fontSize: '12px',
              color: 'var(--accent)', background: 'none', border: 'none',
              borderBottom: '1px solid var(--border-light)', cursor: 'pointer',
              fontFamily: 'var(--font-body)',
            }}
            className="md:hidden"
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
