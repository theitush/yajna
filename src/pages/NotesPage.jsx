/**
 * Notes = the tag pool (#9, #34).
 *
 * The left pane lists every #tag that exists anywhere — journal days, tasks,
 * other notes — whether or not a note row has ever been stored for it, ranked
 * by last use. Selecting one opens its note: Region A is the note's own body,
 * Region B ("From the journal") is the stream derived from every paragraph the
 * tag has captured. Editing a streamed paragraph forks it into this note; the
 * journal is never written from here.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import useHighlightTarget from '../lib/useHighlightTarget'
import { blocksToHtml, sortByOrder } from '../lib/blocks'
import { canonicalTag, tagFromTitle } from '../lib/hashtags'
import { noteStream, resolveTagNote, isForkBlock } from '../lib/tagIndex'
import useAppStore from '../store/useAppStore'
import { HashtagExtension } from '../components/editor/HashtagExtension'
import NoteBodyEditor from '../components/notes/NoteBodyEditor'
import TagNoteStream from '../components/notes/TagNoteStream'
import PortNotesBanner from '../components/notes/PortNotesBanner'
import { needsTag } from '../components/notes/portNotes'
import RecordFab from '../components/voice/RecordFab'
import '../components/notes/tagNotes.css'

export default function NotesPage() {
  const notes = useAppStore(s => s.notes)
  const tagIndex = useAppStore(s => s.tagIndex)
  const config = useAppStore(s => s.config)
  const addNote = useAppStore(s => s.addNote)
  const updateNote = useAppStore(s => s.updateNote)
  const deleteNote = useAppStore(s => s.deleteNote)
  const updateConfig = useAppStore(s => s.updateConfig)
  const getTags = useAppStore.getState().getAllTags

  const [params, setParams] = useSearchParams()
  const urlTag = canonicalTag(params.get('tag'))
  const urlId = params.get('id')

  const [mobileView, setMobileView] = useState(urlTag || urlId ? 'editor' : 'list')
  const [bodyEditor, setBodyEditor] = useState(null)
  const [streamEditor, setStreamEditor] = useState(null)
  const [newTag, setNewTag] = useState(null)      // null = the "+" form is closed
  const [newTagError, setNewTagError] = useState(null)
  const [renameValue, setRenameValue] = useState(null)
  const [renameError, setRenameError] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const highlightBlock = useHighlightTarget('block')

  // ---- selection ----------------------------------------------------------
  // `?tag=` is the selection. `?id=` still works for Search links: it resolves
  // to the note, and from there to the tag the note answers to — a legacy note
  // whose title isn't a tag yet stays selected by id.
  const selectedNote = useMemo(() => {
    if (urlTag) return resolveTagNote(notes, urlTag)
    if (urlId) return notes.find(n => n.id === urlId) || null
    return null
  }, [notes, urlTag, urlId])
  const selectedTag = urlTag || (selectedNote ? canonicalTag(selectedNote.title) : null)
  const selectionKey = urlTag ? `tag:${urlTag}` : (selectedNote ? `id:${selectedNote.id}` : null)

  useEffect(() => {
    if (selectionKey) setMobileView('editor')
  }, [selectionKey])

  useEffect(() => {
    setRenameValue(null)
    setRenameError(null)
    setConfirmDelete(false)
  }, [selectionKey])

  // ---- the list = the tag pool -------------------------------------------
  const rows = useMemo(() => {
    const out = []
    const seenKey = new Set()
    const seenNote = new Set()
    for (const tag of getTags()) {
      const note = resolveTagNote(notes, tag)
      // A tag that resolves through an alias lists under the note's LIVE tag,
      // so a renamed note doesn't show up twice (the forwarding address, #9).
      const liveTag = note ? canonicalTag(note.title) : tag
      const key = liveTag || `note:${note.id}`
      if (seenKey.has(key)) continue
      seenKey.add(key)
      if (note) seenNote.add(note.id)
      out.push({ key, tag: liveTag, note, needsTag: note ? needsTag(note) : false })
    }
    const rest = notes
      .filter(n => !seenNote.has(n.id))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    for (const note of rest) {
      const liveTag = canonicalTag(note.title)
      const key = liveTag || `note:${note.id}`
      if (seenKey.has(key)) continue
      seenKey.add(key)
      out.push({ key, tag: liveTag, note, needsTag: needsTag(note) })
    }
    return out
    // getTags() reads the store's tagIndex directly, so the index is a real
    // dependency of this list even though it isn't named in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, tagIndex, getTags])

  // ---- the two regions ----------------------------------------------------
  const entries = useMemo(
    () => (selectedTag ? noteStream(tagIndex, notes, selectedTag) : []),
    [tagIndex, notes, selectedTag],
  )
  const bodyHtml = useMemo(() => {
    if (!selectedNote) return ''
    const blocks = selectedNote.blocks || []
    if (blocks.length) return blocksToHtml(blocks.filter(b => !isForkBlock(b)))
    return selectedNote.body || ''
  }, [selectedNote])

  // A tag with no stored row shows an empty body; the first keystroke mints
  // the row. One in-flight create per selection, so two saves racing the
  // debounce can't produce two notes for one tag.
  const creating = useRef({ key: null, promise: null })
  const ensureNote = async () => {
    if (selectedNote) return selectedNote
    if (!selectedTag) return null
    if (creating.current.key !== selectionKey) {
      creating.current = { key: selectionKey, promise: addNote(selectedTag) }
    }
    return creating.current.promise
  }

  /**
   * The single write path for both regions. Region A owns the note's own
   * blocks, Region B owns the forks; each save carries its own half and reads
   * the other half back from the store, because `blocks` is one array and
   * stampBlocksFromDoc tombstones whatever is missing from it.
   */
  const persistNote = async ({ ownBlocks, forkBlocks, hiddenOrigins, tags }) => {
    const note = await ensureNote()
    if (!note) return
    const fresh = useAppStore.getState().notes.find(n => n.id === note.id)
    if (!fresh) return
    const live = (fresh.blocks || []).filter(b => b && !b.deleted)
    const nextOwn = ownBlocks || sortByOrder(live.filter(b => !isForkBlock(b)))
    const nextForks = forkBlocks || sortByOrder(live.filter(b => isForkBlock(b)))
    const updates = { blocks: [...nextOwn, ...nextForks] }
    if (tags) updates.tags = tags
    // Only when it actually moved: writing the same array every save would
    // bump the field's LWW stamp on every keystroke pause for nothing.
    if (hiddenOrigins && hiddenOrigins.join('\u0000') !== (fresh.hiddenOrigins || []).join('\u0000')) {
      updates.hiddenOrigins = hiddenOrigins
    }
    await updateNote(note.id, updates)
  }

  // ---- search highlight ---------------------------------------------------
  // Drive the highlight via a ProseMirror decoration (see
  // SearchHighlightExtension). Both regions are searched: a forked paragraph
  // lives in the stream, the note's own writing in the body.
  useEffect(() => {
    const editors = [bodyEditor, streamEditor].filter(Boolean)
    if (editors.length === 0) return
    for (const ed of editors) ed.commands.setSearchHighlight(highlightBlock || null)
    if (!highlightBlock) return
    const sel = `[data-bid="${CSS.escape(highlightBlock)}"]`
    let cancelled = false
    const tryScroll = () => {
      if (cancelled) return false
      for (const ed of editors) {
        const el = ed.view?.dom?.querySelector(sel)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return true
        }
      }
      return false
    }
    const clear = () => {
      cancelled = true
      for (const ed of editors) {
        if (!ed.isDestroyed) ed.commands.setSearchHighlight(null)
      }
    }
    if (!tryScroll()) {
      const observers = editors.map(ed => {
        const obs = new MutationObserver(() => { if (tryScroll()) obs.disconnect() })
        if (ed.view?.dom) obs.observe(ed.view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-bid'] })
        return obs
      })
      const stop = setTimeout(() => observers.forEach(o => o.disconnect()), 3000)
      return () => {
        clearTimeout(stop)
        observers.forEach(o => o.disconnect())
        clear()
      }
    }
    return clear
  }, [highlightBlock, bodyEditor, streamEditor, selectionKey])

  // ---- actions ------------------------------------------------------------
  const selectTag = (tag) => {
    const next = new URLSearchParams()
    next.set('tag', tag)
    setParams(next, { replace: true })
    setMobileView('editor')
  }
  // The shared hashtag extension (same one the journal uses: tag colouring,
  // the capture frame, tap-to-open). A tag tapped inside a note selects that
  // tag here. Configured once; the click handler reads the latest selectTag
  // through a ref so the editors never see a new extension object.
  const selectTagRef = useRef(selectTag)
  selectTagRef.current = selectTag
  const hashtagExtension = useMemo(
    () => HashtagExtension.configure({ onTagClick: tag => selectTagRef.current(tag) }),
    [],
  )
  const selectNoteId = (id) => {
    const next = new URLSearchParams()
    next.set('id', id)
    setParams(next, { replace: true })
    setMobileView('editor')
  }
  const clearSelection = () => {
    setParams(new URLSearchParams(), { replace: true })
    setMobileView('list')
  }

  const commitNewTag = async () => {
    const tag = canonicalTag(newTag)
    if (!tag) {
      setNewTagError('A tag is one word — letters, numbers, - or _')
      return
    }
    if (resolveTagNote(notes, tag)) {
      setNewTagError(`#${tag} already has a note`)
      return
    }
    await addNote(tag)
    setNewTag(null)
    setNewTagError(null)
    selectTag(tag)
  }

  const commitRename = async () => {
    if (renameValue == null) return
    const tag = canonicalTag(renameValue)
    if (!tag) {
      setRenameError('A tag is one word — letters, numbers, - or _')
      return
    }
    if (tag === selectedTag) {
      setRenameValue(null)
      setRenameError(null)
      return
    }
    const clash = resolveTagNote(notes, tag)
    if (clash && clash.id !== selectedNote?.id) {
      setRenameError(`#${tag} already exists`)
      return
    }
    if (selectedNote) await updateNote(selectedNote.id, { title: tag })
    setRenameValue(null)
    setRenameError(null)
    selectTag(tag)
  }

  const handleDelete = async () => {
    if (!selectedNote) return
    await deleteNote(selectedNote.id)
    setConfirmDelete(false)
    clearSelection()
  }

  const showMarkers = config?.tagNoteDateMarkers !== false

  const headerLabel = selectedTag
    ? `#${selectedTag}`
    : (selectedNote?.title || 'Untitled')

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-primary)', position: 'relative' }}>
      {/* The tag pool */}
      <div
        style={{
          flexShrink: 0,
          borderRight: '1px solid var(--border-light)',
          flexDirection: 'column',
          display: mobileView === 'list' ? 'flex' : undefined,
        }}
        className={mobileView !== 'list' ? 'hidden md:flex md:w-[260px]' : 'w-full md:w-[260px]'}
      >
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '6px',
          padding: '10px 12px', borderBottom: '1px solid var(--border-light)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '10px', fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              Tags
            </span>
            <button
              onClick={() => { setNewTag(newTag == null ? '' : null); setNewTagError(null) }}
              title="New tag"
              style={{
                fontSize: '14px', color: 'var(--accent)',
                background: 'var(--accent-light)',
                border: 'none', width: '22px', height: '22px',
                borderRadius: '6px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-body)',
              }}
            >
              {newTag == null ? '+' : '×'}
            </button>
          </div>
          {newTag != null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <input
                autoFocus
                value={newTag}
                placeholder="#tag"
                onChange={e => { setNewTag(e.target.value); setNewTagError(null) }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitNewTag() }
                  if (e.key === 'Escape') { setNewTag(null); setNewTagError(null) }
                }}
                style={{
                  fontSize: '12px', color: 'var(--text-primary)',
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-mid)',
                  borderRadius: '4px', padding: '3px 6px',
                  fontFamily: 'var(--font-body)', outline: 'none',
                }}
              />
              {newTagError && (
                <span style={{ fontSize: '10px', color: '#FCA5A5' }}>{newTagError}</span>
              )}
            </div>
          )}
        </div>
        <PortNotesBanner notes={notes} updateNote={updateNote} />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rows.length === 0 && (
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '12px' }}>
              No tags yet — write #something in today's entry.
            </p>
          )}
          {rows.map(row => {
            const active = (!!row.tag && row.tag === selectedTag)
              || (!!selectedNote && row.note?.id === selectedNote.id)
            return (
              <button
                key={row.key}
                onClick={() => (row.tag ? selectTag(row.tag) : selectNoteId(row.note.id))}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '10px 12px',
                  borderTop: 'none', borderRight: 'none',
                  borderBottom: '1px solid var(--border-light)',
                  borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                  background: active ? 'var(--bg-secondary)' : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                <p className="tag-row-name">
                  {row.tag
                    ? <><span className="tag-row-hash">#</span>{row.tag}</>
                    : (row.note?.title || 'Untitled')}
                </p>
                {row.needsTag && <p className="tag-row-meta"><span className="tag-row-needs">needs a tag</span></p>}
              </button>
            )
          })}
        </div>
      </div>

      {/* The note */}
      <div
        style={{
          flex: 1, flexDirection: 'column', overflow: 'hidden',
          display: mobileView === 'editor' ? 'flex' : undefined,
        }}
        className={mobileView !== 'editor' ? 'hidden md:flex' : ''}
      >
        {mobileView === 'editor' && (
          <button
            onClick={clearSelection}
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

        {!selectionKey ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: '13px' }}>
            Pick a tag, or start a new one
          </div>
        ) : (
          <div className="tag-note-pane">
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '12px 20px', borderBottom: '1px solid var(--border-light)',
            }}>
              {renameValue != null ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: 0 }}>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => { setRenameValue(e.target.value); setRenameError(null) }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      if (e.key === 'Escape') { setRenameValue(null); setRenameError(null) }
                    }}
                    onBlur={() => { if (!renameError) commitRename() }}
                    style={{
                      fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)',
                      background: 'var(--bg-secondary)', border: '1px solid var(--border-mid)',
                      borderRadius: '4px', padding: '2px 6px',
                      fontFamily: 'var(--font-body)', outline: 'none',
                      width: '100%', minWidth: 0,
                    }}
                  />
                  {renameError && <span style={{ fontSize: '10px', color: '#FCA5A5' }}>{renameError}</span>}
                </div>
              ) : (
                <span
                  onClick={() => setRenameValue(selectedTag || tagFromTitle(selectedNote?.title) || '')}
                  title={selectedTag ? 'Click to rename the tag' : 'Click to give this note a tag'}
                  style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text', flex: 1, minWidth: 0 }}
                >
                  {headerLabel}
                  {!selectedTag && <span className="tag-row-needs" style={{ marginInlineStart: '8px' }}>needs a tag</span>}
                </span>
              )}
              <button
                onClick={() => updateConfig({ tagNoteDateMarkers: !showMarkers })}
                title={showMarkers ? 'Hide the day markers' : 'Show the day markers'}
                style={{
                  fontSize: '11px', padding: '3px 8px', borderRadius: '8px',
                  background: showMarkers ? 'var(--accent-light)' : 'transparent',
                  color: showMarkers ? 'var(--accent)' : 'var(--text-tertiary)',
                  border: '1px solid var(--border-light)', cursor: 'pointer',
                  fontFamily: 'var(--font-body)', whiteSpace: 'nowrap',
                }}
              >
                dates
              </button>
              {selectedNote && (confirmDelete ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    onClick={handleDelete}
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
                  }}
                >
                  Delete
                </button>
              ))}
            </div>

            <div className="tag-note-scroll">
              <NoteBodyEditor
                key={`body:${selectionKey}`}
                content={bodyHtml}
                noteId={selectedNote?.id || null}
                noteTitle={headerLabel}
                hashtagExtension={hashtagExtension}
                getTags={getTags}
                onSave={({ blocks, tags }) => persistNote({ ownBlocks: blocks, tags })}
                onEditorReady={setBodyEditor}
              />
              <TagNoteStream
                key={`stream:${selectionKey}`}
                entries={entries}
                noteId={selectedNote?.id || null}
                noteTitle={headerLabel}
                hiddenOrigins={selectedNote?.hiddenOrigins || []}
                showMarkers={showMarkers}
                hashtagExtension={hashtagExtension}
                getTags={getTags}
                onPersist={({ forkBlocks, hiddenOrigins }) => persistNote({ forkBlocks, hiddenOrigins })}
                onEditorReady={setStreamEditor}
              />
            </div>
          </div>
        )}
      </div>
      {selectionKey && bodyEditor && <RecordFab editor={bodyEditor} />}
    </div>
  )
}
