import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import useHighlightTarget from '../lib/useHighlightTarget'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer } from '@tiptap/pm/model'
import { docToBlocks, blocksToHtml } from '../lib/blocks'
import useAppStore from '../store/useAppStore'
import EditorToolbar from '../components/editor/EditorToolbar'
import { RTLExtension } from '../components/editor/RTLExtension'
import { AudioNode } from '../components/editor/AudioNode'
import { BlockIdExtension } from '../components/editor/BlockIdExtension'
import { SearchHighlightExtension } from '../components/editor/SearchHighlightExtension'
import { HashtagSuggest } from '../components/editor/HashtagSuggest'
import { HeadingNoShortcut } from '../components/editor/HeadingNoShortcut'
import RecordFab from '../components/voice/RecordFab'

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

function NoteEditor({ note, onUpdate, onDelete, onEditorReady, getTags, autoFocusTitle, onDidAutoFocusTitle, onDraftTitleChange }) {
  const saveTimeout = useRef(null)
  const titleInputRef = useRef(null)
  const focusBodyAfterTitleBlurRef = useRef(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState(note?.title || '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      Placeholder.configure({ placeholder: 'Write your note…' }),
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      HashtagExtension,
      HashtagSuggest.configure({ getTags }),
      RTLExtension,
      AudioNode.configure({
        getSource: () => ({
          sourceType: 'note',
          sourceId: note?.id || null,
          sourceTitle: note?.title || 'Untitled',
        }),
      }),
      BlockIdExtension,
      SearchHighlightExtension,
    ],
    content: (note?.body ?? blocksToHtml(note?.blocks)) || '',
    onUpdate: ({ editor }) => {
      const body = editor.getHTML()
      const serializer = DOMSerializer.fromSchema(editor.schema)
      const blocks = docToBlocks(editor.state.doc, serializer)
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        saveTimeout.current = null
        const tags = extractTags(editor.getText())
        onUpdate(note.id, { body, blocks, tags })
      }, 800)
    },
  })

  useEffect(() => {
    if (!editor || !note) return
    setTitleValue(note.title || '')
    if (onDraftTitleChange) onDraftTitleChange(note.title || '')
    setEditingTitle(false)
    setConfirmDelete(false)
  }, [note?.id])

  useEffect(() => {
    if (!note || !autoFocusTitle) return
    setEditingTitle(true)
    setTitleValue(note.title || '')
    requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      if (onDidAutoFocusTitle) onDidAutoFocusTitle()
    })
  }, [note?.id, autoFocusTitle, onDidAutoFocusTitle])

  const remoteHtml = note ? (note.body ?? blocksToHtml(note.blocks) ?? '') : ''
  useEffect(() => {
    if (!editor || !note) return
    if (saveTimeout.current) return
    const current = editor.getHTML()
    if (current !== remoteHtml) {
      editor.commands.setContent(remoteHtml, { emitUpdate: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, note?.id, remoteHtml])

  useEffect(() => {
    if (onEditorReady) onEditorReady(editor || null)
  }, [editor, onEditorReady])

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
            ref={titleInputRef}
            value={titleValue}
            onChange={e => {
              const next = e.target.value
              setTitleValue(next)
              if (onDraftTitleChange) onDraftTitleChange(next)
            }}
            onBlur={() => {
              const trimmed = titleValue.trim()
              setEditingTitle(false)
              onUpdate(note.id, { title: trimmed })
              setTitleValue(trimmed)
              if (onDraftTitleChange) onDraftTitleChange(trimmed)
              if (focusBodyAfterTitleBlurRef.current) {
                focusBodyAfterTitleBlurRef.current = false
                requestAnimationFrame(() => {
                  if (!editor) return
                  try {
                    editor.commands.focus('start')
                  } catch {
                    editor.commands.focus()
                  }
                })
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                focusBodyAfterTitleBlurRef.current = true
                e.currentTarget.blur()
              }
              if (e.key === 'Escape') {
                e.currentTarget.blur()
              }
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
            {note.title || ''}
          </span>
        )}
        {confirmDelete ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => onDelete(note.id)}
              style={{
                fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
                background: 'rgba(239,68,68,0.15)', color: '#FCA5A5',
                border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              Move to trash
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

export default function NotesPage() {
  const notes = useAppStore(s => s.notes)
  const addNote = useAppStore(s => s.addNote)
  const updateNote = useAppStore(s => s.updateNote)
  const deleteNote = useAppStore(s => s.deleteNote)
  const getTags = useAppStore.getState().getAllTags
  const [params, setParams] = useSearchParams()
  const urlNoteId = params.get('id')
  const [selectedNoteId, setSelectedNoteId] = useState(urlNoteId || null)
  const [mobileView, setMobileView] = useState(urlNoteId ? 'editor' : 'list')
  const [activeEditor, setActiveEditor] = useState(null)
  const [autoFocusTitleNoteId, setAutoFocusTitleNoteId] = useState(null)
  const [selectedDraftTitle, setSelectedDraftTitle] = useState('')
  const [sortBy, setSortBy] = useState(() => {
    try {
      const v = window.localStorage.getItem('notes.sortBy')
      return (v === 'az' || v === 'lastEdited' || v === 'date') ? v : 'lastEdited'
    } catch {
      return 'lastEdited'
    }
  })
  const highlightBlock = useHighlightTarget('block')

  // Drive the highlight via a ProseMirror decoration (see
  // SearchHighlightExtension). We previously toggled the class imperatively
  // on the DOM node, but tiptap re-renders block nodes on its own
  // transactions and would wipe the class. The decoration survives those.
  // We also scroll the matching DOM node into view once it exists.
  useEffect(() => {
    if (!activeEditor) return
    activeEditor.commands.setSearchHighlight(highlightBlock || null)
    if (!highlightBlock) return
    const dom = activeEditor.view?.dom
    if (!dom) return
    const sel = `[data-bid="${CSS.escape(highlightBlock)}"]`
    let cancelled = false
    const tryScroll = () => {
      if (cancelled) return false
      const el = dom.querySelector(sel)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return true
      }
      return false
    }
    if (!tryScroll()) {
      const obs = new MutationObserver(() => { if (tryScroll()) obs.disconnect() })
      obs.observe(dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-bid'] })
      const stop = setTimeout(() => obs.disconnect(), 3000)
      return () => {
        cancelled = true
        clearTimeout(stop)
        obs.disconnect()
        activeEditor.commands.setSearchHighlight(null)
      }
    }
    return () => {
      cancelled = true
      activeEditor.commands.setSearchHighlight(null)
    }
  }, [highlightBlock, activeEditor, selectedNoteId])

  // If the URL changes (e.g. arriving from Search), follow it.
  useEffect(() => {
    if (urlNoteId && urlNoteId !== selectedNoteId) {
      setSelectedNoteId(urlNoteId)
      setMobileView('editor')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlNoteId])

  const selectedNote = notes.find(n => n.id === selectedNoteId) || null
  useEffect(() => {
    setSelectedDraftTitle(selectedNote?.title || '')
  }, [selectedNoteId, selectedNote?.title])

  useEffect(() => {
    try {
      window.localStorage.setItem('notes.sortBy', sortBy)
    } catch {}
  }, [sortBy])

  const clearUrlNoteId = () => {
    if (params.get('id')) {
      const p = new URLSearchParams(params)
      p.delete('id')
      setParams(p, { replace: true })
    }
  }

  const handleNew = async () => {
    const note = await addNote('', [])
    setSelectedNoteId(note.id)
    setMobileView('editor')
    setAutoFocusTitleNoteId(note.id)
    clearUrlNoteId()
  }

  const handleSelect = (id) => {
    setSelectedNoteId(id)
    setMobileView('editor')
    setAutoFocusTitleNoteId(null)
    clearUrlNoteId()
  }

  const handleDelete = async (id) => {
    await deleteNote(id)
    setSelectedNoteId(null)
    setMobileView('list')
    setAutoFocusTitleNoteId(null)
    clearUrlNoteId()
  }

  const sortedNotes = [...notes].sort((a, b) => {
    if (sortBy === 'az') {
      const ta = (a.title || '').trim()
      const tb = (b.title || '').trim()
      if (!ta && tb) return 1
      if (ta && !tb) return -1
      return ta.localeCompare(tb, undefined, { sensitivity: 'base' })
    }
    if (sortBy === 'date') {
      const ad = new Date(a.createdAt || 0).getTime()
      const bd = new Date(b.createdAt || 0).getTime()
      return bd - ad
    }
    const au = new Date(a.updatedAt || a.createdAt || 0).getTime()
    const bu = new Date(b.updatedAt || b.createdAt || 0).getTime()
    return bu - au
  })

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
          display: 'flex', flexDirection: 'column', gap: '6px',
          padding: '10px 12px', borderBottom: '1px solid var(--border-light)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Sort by:</span>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                background: 'transparent',
                border: 'none',
                padding: 0,
                fontFamily: 'var(--font-body)',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="az">A-Z</option>
              <option value="lastEdited">Last Edit</option>
              <option value="date">Date</option>
            </select>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {notes.length === 0 && (
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '12px' }}>No notes yet</p>
          )}
          {sortedNotes.map(note => (
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
                {(note.id === selectedNoteId ? selectedDraftTitle : note.title) || ''}
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
          onEditorReady={setActiveEditor}
          getTags={getTags}
          autoFocusTitle={autoFocusTitleNoteId && selectedNoteId === autoFocusTitleNoteId}
          onDidAutoFocusTitle={() => setAutoFocusTitleNoteId(null)}
          onDraftTitleChange={setSelectedDraftTitle}
        />
      </div>
      {selectedNote && activeEditor && <RecordFab editor={activeEditor} />}
    </div>
  )
}
