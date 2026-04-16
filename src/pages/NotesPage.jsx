import { useState, useEffect, useMemo } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
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
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState(note?.title || '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Write your note…' }),
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
    setTitleValue(note.title || '')
    setEditingTitle(false)
    setConfirmDelete(false)
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
        {editingTitle ? (
          <input
            autoFocus
            value={titleValue}
            onChange={e => setTitleValue(e.target.value)}
            onBlur={() => {
              setEditingTitle(false)
              onUpdate(note.id, { title: titleValue.trim() || 'Untitled' })
              setTitleValue(titleValue.trim() || 'Untitled')
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === 'Escape') e.target.blur()
            }}
            style={{
              fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)',
              background: 'var(--bg-secondary)', border: '1px solid var(--border-mid)',
              borderRadius: '4px', padding: '2px 6px',
              fontFamily: 'var(--font-body)', outline: 'none',
              flex: 1, minWidth: 0,
            }}
          />
        ) : (
          <span
            onClick={() => { setEditingTitle(true); setTitleValue(note.title || '') }}
            title="Click to edit title"
            style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text', flex: 1, minWidth: 0 }}
          >
            {note.title || 'Untitled'}
          </span>
        )}
        {confirmDelete ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: '#FCA5A5', fontFamily: 'var(--font-body)' }}>Delete?</span>
            <button
              onClick={() => onDelete(note.id)}
              style={{
                fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
                background: 'rgba(239,68,68,0.15)', color: '#FCA5A5',
                border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{
                fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
                background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
                border: '1px solid var(--border-light)', cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            style={{
              fontSize: '12px', color: '#FCA5A5',
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '4px 8px', fontFamily: 'var(--font-body)',
              transition: 'color 0.15s',
            }}
          >
            Delete
          </button>
        )}
      </div>
      <EditorToolbar editor={editor} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', fontSize: '14px', color: 'var(--text-primary)' }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

function TagStrip({ allTags, selectedTags, onToggleTag, onClearTags }) {
  const [tagSearch, setTagSearch] = useState('')
  const [expanded, setExpanded] = useState(false)

  const filteredTags = useMemo(() => {
    if (!tagSearch) return allTags
    const q = tagSearch.toLowerCase()
    return allTags.filter(t => t.toLowerCase().includes(q))
  }, [allTags, tagSearch])

  if (allTags.length === 0) return null

  const showSearch = allTags.length > 8
  const visibleTags = expanded ? filteredTags : filteredTags.slice(0, 12)
  const hasMore = !expanded && filteredTags.length > 12

  return (
    <div style={{
      borderTop: '1px solid var(--border-light)',
      flexShrink: 0,
    }}>
      {showSearch && (
        <div style={{ padding: '6px 8px 0' }}>
          <input
            value={tagSearch}
            onChange={e => setTagSearch(e.target.value)}
            placeholder="Filter tags…"
            style={{
              width: '100%', fontSize: '11px',
              padding: '4px 8px', borderRadius: '6px',
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-light)',
              fontFamily: 'var(--font-body)', outline: 'none',
            }}
          />
        </div>
      )}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px',
        padding: '8px',
        maxHeight: expanded ? '140px' : '68px',
        overflowY: expanded ? 'auto' : 'hidden',
        transition: 'max-height 0.2s',
      }}>
        <button
          onClick={onClearTags}
          style={{
            fontSize: '11px', whiteSpace: 'nowrap',
            padding: '2px 8px', borderRadius: '10px',
            background: selectedTags.length === 0 ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: selectedTags.length === 0 ? '#fff' : 'var(--text-secondary)',
            border: 'none', cursor: 'pointer',
            transition: 'all 0.15s',
            fontFamily: 'var(--font-body)',
          }}
        >
          All
        </button>
        {visibleTags.map(tag => {
          const isActive = selectedTags.includes(tag)
          return (
            <button
              key={tag}
              onClick={() => onToggleTag(tag)}
              style={{
                fontSize: '11px', whiteSpace: 'nowrap',
                padding: '2px 8px', borderRadius: '10px',
                background: isActive ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: isActive ? '#fff' : 'var(--text-secondary)',
                border: 'none', cursor: 'pointer',
                transition: 'all 0.15s',
                fontFamily: 'var(--font-body)',
              }}
            >
              #{tag}
            </button>
          )
        })}
        {hasMore && (
          <button
            onClick={() => setExpanded(true)}
            style={{
              fontSize: '11px', whiteSpace: 'nowrap',
              padding: '2px 8px', borderRadius: '10px',
              background: 'none', color: 'var(--accent)',
              border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-body)',
            }}
          >
            +{filteredTags.length - 12} more
          </button>
        )}
      </div>
    </div>
  )
}

export default function NotesPage() {
  const notes = useAppStore(s => s.notes)
  const addNote = useAppStore(s => s.addNote)
  const updateNote = useAppStore(s => s.updateNote)
  const deleteNote = useAppStore(s => s.deleteNote)
  const [selectedTags, setSelectedTags] = useState([])
  const [selectedNoteId, setSelectedNoteId] = useState(null)
  const [mobileView, setMobileView] = useState('list')

  const allTags = [...new Set(notes.flatMap(n => n.tags || []))].sort()
  const filteredNotes = selectedTags.length > 0
    ? notes.filter(n => selectedTags.some(t => n.tags?.includes(t)))
    : notes
  const selectedNote = notes.find(n => n.id === selectedNoteId) || null

  const handleToggleTag = (tag) => {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
  }

  const handleClearTags = () => setSelectedTags([])

  const handleNew = async () => {
    const note = await addNote('', selectedTags.length > 0 ? [...selectedTags] : [])
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
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Notes list + tag strip */}
      <div
        style={{
          flexShrink: 0,
          borderRight: '1px solid var(--border-light)',
          flexDirection: 'column',
          display: mobileView === 'list' ? 'flex' : undefined,
        }}
        className={
          mobileView !== 'list'
            ? 'hidden md:flex md:w-[260px]'
            : 'w-full md:w-[260px]'
        }
      >
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
                borderTop: 'none', borderRight: 'none',
                borderBottom: '1px solid var(--border-light)',
                borderLeft: note.id === selectedNoteId ? '2px solid var(--accent)' : '2px solid transparent',
                background: note.id === selectedNoteId ? 'var(--bg-secondary)' : 'transparent',
                cursor: 'pointer',
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
        <TagStrip
          allTags={allTags}
          selectedTags={selectedTags}
          onToggleTag={handleToggleTag}
          onClearTags={handleClearTags}
        />
      </div>

      {/* Editor */}
      <div
        style={{
          flex: 1, flexDirection: 'column', overflow: 'hidden',
          display: mobileView === 'editor' ? 'flex' : undefined,
        }}
        className={mobileView !== 'editor' ? 'hidden md:flex' : ''}
      >
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
