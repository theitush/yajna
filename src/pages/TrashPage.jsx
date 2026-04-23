import { useEffect, useMemo, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import useAppStore from '../store/useAppStore'
import { AudioNode } from '../components/editor/AudioNode'
import { BlockIdExtension } from '../components/editor/BlockIdExtension'
import { RTLExtension } from '../components/editor/RTLExtension'
import { HeadingNoShortcut } from '../components/editor/HeadingNoShortcut'
import { blocksToHtml } from '../lib/blocks'

function fmtWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!isFinite(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

const sectionHeaderStyle = {
  fontSize: '10px', fontWeight: 500, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 4px 8px',
}

const cardStyle = {
  background: 'var(--bg-primary)',
  border: '1px solid var(--border-light)',
  borderRadius: '12px',
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

const dangerBtn = {
  fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
  background: 'rgba(239,68,68,0.15)', color: '#FCA5A5',
  border: '1px solid rgba(239,68,68,0.3)', cursor: 'pointer',
  fontFamily: 'var(--font-body)',
}

const subtleBtn = {
  fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
  background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
  border: '1px solid var(--border-light)', cursor: 'pointer',
  fontFamily: 'var(--font-body)',
}

function TaskTrashCard({ task, onPurge, onRestore }) {
  const [confirm, setConfirm] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const hasDetail = task.explanation || task.feedback || task.tags
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>
            {task.title || '(untitled task)'}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            Created {fmtWhen(task.createdAt)} · Trashed {fmtWhen(task.deletedAt)}
          </p>
        </div>
        {hasDetail && (
          <button onClick={() => setExpanded(e => !e)} style={subtleBtn}>
            {expanded ? 'Hide' : 'View'}
          </button>
        )}
      </div>
      {expanded && hasDetail && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '2px' }}>
          {task.explanation && <p dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{task.explanation}</p>}
          {task.feedback && <p dir="auto" style={{ whiteSpace: 'pre-wrap', color: 'var(--text-tertiary)' }}>{task.feedback}</p>}
          {task.tags && <p dir="auto" style={{ color: 'var(--accent)', fontWeight: 500 }}>{task.tags}</p>}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        {confirm ? (
          <>
            <button style={dangerBtn} onClick={() => onPurge(task.id)}>Delete forever</button>
            <button style={subtleBtn} onClick={() => setConfirm(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button style={subtleBtn} onClick={() => onRestore(task.id)}>Restore</button>
            <button style={dangerBtn} onClick={() => setConfirm(true)}>Delete forever</button>
          </>
        )}
      </div>
    </div>
  )
}

function NotePreviewModal({ note, onClose }) {
  const html = useMemo(() => blocksToHtml(note?.blocks) || '', [note])
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      RTLExtension,
      AudioNode.configure({ readOnly: true }),
      BlockIdExtension,
    ],
    content: html,
    editable: false,
  }, [note?.id])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 500,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary)', borderRadius: '12px',
          width: 'min(720px, 100%)', maxHeight: '90vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          border: '1px solid var(--border-light)',
        }}
      >
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {note?.title || 'Untitled'}
            </p>
            <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              Created {fmtWhen(note?.createdAt)} · Trashed {fmtWhen(note?.deletedAt)}
            </p>
          </div>
          <button onClick={onClose} style={subtleBtn}>Close</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', fontSize: '14px', color: 'var(--text-primary)' }}>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}

function NoteTrashCard({ note, onPurge, onRestore }) {
  const [confirm, setConfirm] = useState(false)
  const [open, setOpen] = useState(false)
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {note.title || 'Untitled'}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            Created {fmtWhen(note.createdAt)} · Trashed {fmtWhen(note.deletedAt)}
          </p>
        </div>
        <button style={subtleBtn} onClick={() => setOpen(true)}>View</button>
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        {confirm ? (
          <>
            <button style={dangerBtn} onClick={() => onPurge(note.id)}>Delete forever</button>
            <button style={subtleBtn} onClick={() => setConfirm(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button style={subtleBtn} onClick={() => onRestore(note.id)}>Restore</button>
            <button style={dangerBtn} onClick={() => setConfirm(true)}>Delete forever</button>
          </>
        )}
      </div>
      {open && <NotePreviewModal note={note} onClose={() => setOpen(false)} />}
    </div>
  )
}

function AudioTrashCard({ audio, onPurge, onRestore }) {
  const [confirm, setConfirm] = useState(false)
  const [restoreError, setRestoreError] = useState(null)
  const handleRestore = async () => {
    setRestoreError(null)
    const result = await onRestore(audio.id)
    if (result && result.ok === false) setRestoreError(result.reason || 'Could not restore.')
  }
  const html = `<div data-audio-id="${audio.id}" data-duration="${audio.duration || 0}"></div>`
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      AudioNode.configure({ readOnly: true }),
      BlockIdExtension,
    ],
    content: html,
    editable: false,
  }, [audio.id])

  const sourceLabel = audio.sourceTitle
    ? `${audio.sourceType === 'journal' ? 'Journal' : 'Note'}: ${audio.sourceTitle}`
    : 'Unknown source'

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
            {sourceLabel}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            Recorded {fmtWhen(audio.createdAt)} · Trashed {fmtWhen(audio.deletedAt)}
          </p>
        </div>
      </div>
      <div>
        <EditorContent editor={editor} />
      </div>
      {restoreError && (
        <p style={{ fontSize: '12px', color: '#FCA5A5', margin: 0 }}>{restoreError}</p>
      )}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        {confirm ? (
          <>
            <button style={dangerBtn} onClick={() => onPurge(audio.id)}>Delete forever</button>
            <button style={subtleBtn} onClick={() => setConfirm(false)}>Cancel</button>
          </>
        ) : (
          <>
            {audio.sourceType && <button style={subtleBtn} onClick={handleRestore}>Restore</button>}
            <button style={dangerBtn} onClick={() => setConfirm(true)}>Delete forever</button>
          </>
        )}
      </div>
    </div>
  )
}

export default function TrashPage() {
  const trashedTasks = useAppStore(s => s.trashedTasks)
  const trashedNotes = useAppStore(s => s.trashedNotes)
  const trashedAudio = useAppStore(s => s.trashedAudio)
  const loadTrash = useAppStore(s => s.loadTrash)
  const purgeTrashedTask = useAppStore(s => s.purgeTrashedTask)
  const purgeTrashedNote = useAppStore(s => s.purgeTrashedNote)
  const purgeTrashedAudio = useAppStore(s => s.purgeTrashedAudio)
  const restoreTrashedTask = useAppStore(s => s.restoreTrashedTask)
  const restoreTrashedNote = useAppStore(s => s.restoreTrashedNote)
  const restoreTrashedAudio = useAppStore(s => s.restoreTrashedAudio)

  useEffect(() => { loadTrash() }, [loadTrash])

  const sortByDeleted = (a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0)
  const tasks = [...trashedTasks].sort(sortByDeleted)
  const notes = [...trashedNotes].sort(sortByDeleted)
  const audio = [...trashedAudio].sort(sortByDeleted)

  const empty = tasks.length === 0 && notes.length === 0 && audio.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '12px 16px', borderBottom: '1px solid var(--border-light)',
        position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 10,
      }}>
        <h1 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)' }}>Trash</h1>
        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          {tasks.length + notes.length + audio.length} items
        </span>
      </div>

      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '720px', width: '100%', alignSelf: 'center' }}>
        {empty && (
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', textAlign: 'center', padding: '40px 0' }}>
            Trash is empty.
          </p>
        )}

        {tasks.length > 0 && (
          <section>
            <h2 style={sectionHeaderStyle}>Todos</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {tasks.map(t => <TaskTrashCard key={t.id} task={t} onPurge={purgeTrashedTask} onRestore={restoreTrashedTask} />)}
            </div>
          </section>
        )}

        {notes.length > 0 && (
          <section>
            <h2 style={sectionHeaderStyle}>Notes</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {notes.map(n => <NoteTrashCard key={n.id} note={n} onPurge={purgeTrashedNote} onRestore={restoreTrashedNote} />)}
            </div>
          </section>
        )}

        {audio.length > 0 && (
          <section>
            <h2 style={sectionHeaderStyle}>Audio</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {audio.map(a => <AudioTrashCard key={a.id} audio={a} onPurge={purgeTrashedAudio} onRestore={restoreTrashedAudio} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
