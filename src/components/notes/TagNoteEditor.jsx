/**
 * A tag-note is ONE editor (#48).
 *
 * It shows `noteDocument(...)`: the note's own blocks in the note's own order,
 * then every paragraph the tag has captured that the note has not placed yet.
 * Writing is just writing — a line stays where it was typed. A captured
 * paragraph is shaded and says where it came from; editing it forks it into
 * this note and the source is left exactly as it was (see noteReconcile.js).
 * This component imports no journal writer, and the only write it can make is
 * the `onPersist` its parent hands it, which writes a note row.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { DOMSerializer } from '@tiptap/pm/model'
import { docToBlocks } from '../../lib/blocks'
import { extractHashtags } from '../../lib/hashtags'
import { RTLExtension } from '../editor/RTLExtension'
import { AudioNode } from '../editor/AudioNode'
import { BlockIdExtension } from '../editor/BlockIdExtension'
import { SearchHighlightExtension } from '../editor/SearchHighlightExtension'
import { HashtagSuggest } from '../editor/HashtagSuggest'
import { HeadingNoShortcut } from '../editor/HeadingNoShortcut'
import { NoteProvenance } from './NoteProvenance'
import { ProvenanceMarkers } from './ProvenanceMarkers'
import { renderNoteHtml, buildBaseline, reconcileNote, docMatchesEntries } from './noteReconcile'
import './tagNotes.css'

const NOTE_SAVE_DEBOUNCE_MS = 800

export default function TagNoteEditor({
  entries,
  noteId,
  noteTitle,
  hiddenOrigins,
  showMarkers,
  sourceLabel,
  hashtagExtension,
  getTags,
  onPersist,
  onEditorReady,
}) {
  const saveTimeout = useRef(null)
  const pending = useRef(null)
  // True from flush until the parent's write has landed. A save on a tag with
  // no stored row yet is two writes (mint the row, then its blocks), and the
  // store between them holds a note with no blocks — re-rendering to that
  // would briefly drop what was just typed and throw the caret. The view is
  // held still until the save settles, then synced once.
  const saving = useRef(false)
  // What the editor serialized the moment the document was rendered, keyed by
  // origin, for the captured blocks. The fork test is "differs from this", so
  // it must always describe exactly what is on screen — recaptured after every
  // setContent, and a save is refused while it is null (a reconcile against no
  // baseline would read every captured block as a paste and strip it).
  const baseline = useRef(null)
  const markerState = useRef({ show: true, forks: new Set(), sourceLabel: null })
  const persistRef = useRef(onPersist)
  persistRef.current = onPersist
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId
  const hiddenRef = useRef(hiddenOrigins)
  hiddenRef.current = hiddenOrigins

  const html = useMemo(() => renderNoteHtml(entries), [entries])
  const forkOrigins = useMemo(
    () => new Set((entries || []).filter(e => e.kind === 'fork').map(e => e.origin)),
    [entries],
  )
  const knownOrigins = useMemo(
    () => new Set((entries || []).filter(e => e.kind !== 'own').map(e => e.origin)),
    [entries],
  )
  const knownRef = useRef(knownOrigins)
  knownRef.current = knownOrigins
  markerState.current = { show: !!showMarkers, forks: forkOrigins, sourceLabel }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      Placeholder.configure({ placeholder: 'Write your note…' }),
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      ...(hashtagExtension ? [hashtagExtension] : []),
      HashtagSuggest.configure({ getTags }),
      RTLExtension,
      // A clip captured from a journal day plays here, but its delete and
      // re-record controls are off — a note must not be able to change the
      // day it came from. The note's own clips keep them.
      AudioNode.configure({
        readOnly: (node) => !!node?.attrs?.origin,
        getSource: () => ({
          sourceType: 'note',
          sourceId: noteIdRef.current || null,
          sourceTitle: noteTitle || '',
        }),
      }),
      BlockIdExtension,
      NoteProvenance.configure({ getKnownOrigins: () => knownRef.current }),
      SearchHighlightExtension,
      ProvenanceMarkers.configure({ getMarkerState: () => markerState.current }),
    ],
    content: html,
    onUpdate: ({ editor }) => {
      if (!baseline.current) return
      const serializer = DOMSerializer.fromSchema(editor.schema)
      pending.current = {
        docBlocks: docToBlocks(editor.state.doc, serializer),
        tags: extractHashtags(editor.getText()),
      }
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        saveTimeout.current = null
        flush.current?.()
      }, NOTE_SAVE_DEBOUNCE_MS)
    },
  })

  const captureBaseline = useRef(null)
  captureBaseline.current = () => {
    if (!editor) return
    const serializer = DOMSerializer.fromSchema(editor.schema)
    baseline.current = buildBaseline(docToBlocks(editor.state.doc, serializer), entries)
  }

  // Flush the debounced edit: reconcile the doc against the baseline and hand
  // the parent the blocks the note should hold. Same hidden/pagehide/unmount
  // discipline as the journal editor — mobile freezes the page on screen-off
  // well before an 800ms debounce fires.
  const flush = useRef(null)
  flush.current = () => {
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current)
      saveTimeout.current = null
    }
    const p = pending.current
    pending.current = null
    if (!p || !baseline.current) return
    const result = reconcileNote({
      baseline: baseline.current,
      docBlocks: p.docBlocks,
      hiddenOrigins: hiddenRef.current,
    })
    saving.current = true
    Promise.resolve(persistRef.current?.({ ...result, tags: p.tags }))
      .catch(() => {})
      .finally(() => {
        saving.current = false
        syncView.current?.()
      })
  }

  useEffect(() => {
    captureBaseline.current?.()
  }, [editor])

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush.current?.() }
    const onPageHide = () => flush.current?.()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      // Runs on unmount and before each selection switch (the parent keys this
      // component on the selection), so the tail of an edit lands on the note
      // it was typed into — persistRef still holds that selection's handler.
      flush.current?.()
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  // Re-render when the store changes — a journal edit on another device, a
  // poll merge, our own save landing. Same two guards as JournalPanel: never
  // rebuild the doc mid-type (setContent resets the caret), and never rebuild
  // when the editor already shows these entries. The second test is
  // content-equal rather than string-equal because a stored block serializes
  // its attributes in ProseMirror's order while a freshly captured source
  // block gets them appended — same block, two spellings.
  const syncView = useRef(null)
  syncView.current = () => {
    if (!editor || editor.isDestroyed) return
    if (saveTimeout.current || saving.current) return
    const serializer = DOMSerializer.fromSchema(editor.schema)
    if (docMatchesEntries(docToBlocks(editor.state.doc, serializer), entries)) {
      // Still recapture: a block's provenance (src/date/fork) comes from the
      // entries, which may have changed even when the html did not.
      captureBaseline.current?.()
      return
    }
    // setContent drops the selection to the start of the doc. Keep the caret
    // where it was (clamped — the doc may have shrunk): a re-render that lands
    // a second after the note opens must not move a writer who has just put
    // the caret at the end.
    const focused = editor.isFocused
    const { from, to } = editor.state.selection
    editor.commands.setContent(html, { emitUpdate: false })
    if (focused) {
      const max = editor.state.doc.content.size
      editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) })
    }
    captureBaseline.current?.()
  }
  useEffect(() => {
    syncView.current?.()
  }, [editor, html, entries])

  // Decorations are recomputed on every view update, so a toggle that changes
  // no document needs one forced.
  useEffect(() => {
    if (!editor?.view) return
    editor.view.setProps({})
  }, [editor, showMarkers, forkOrigins])

  useEffect(() => {
    onEditorReady?.(editor || null)
    return () => onEditorReady?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  return (
    <div className="tag-note-editor">
      <EditorContent editor={editor} />
    </div>
  )
}
