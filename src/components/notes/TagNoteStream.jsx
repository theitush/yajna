/**
 * Region B of a tag-note: "From the journal".
 *
 * A second editor over `noteStream(...)` — the paragraphs every journal day and
 * every other note has captured for this tag. Nothing here is stored until the
 * user edits it; then the note takes its own copy (see streamFork.js) and the
 * source is left exactly as it was. This component imports no journal writer,
 * and the only write it can make is the `onPersist` its parent hands it, which
 * writes a note row.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { DOMSerializer } from '@tiptap/pm/model'
import { docToBlocks } from '../../lib/blocks'
import { today } from '../../lib/dates'
import { RTLExtension } from '../editor/RTLExtension'
import { AudioNode } from '../editor/AudioNode'
import { BlockIdExtension } from '../editor/BlockIdExtension'
import { SearchHighlightExtension } from '../editor/SearchHighlightExtension'
import { HashtagSuggest } from '../editor/HashtagSuggest'
import { HeadingNoShortcut } from '../editor/HeadingNoShortcut'
import { StreamDateMarkers } from './StreamDateMarkers'
import {
  renderStreamHtml, buildBaseline, reconcileStream, streamMatchesEntries,
} from './streamFork'
import './tagNotes.css'

const STREAM_SAVE_DEBOUNCE_MS = 800

export default function TagNoteStream({
  entries,
  noteId,
  noteTitle,
  hiddenOrigins,
  showMarkers,
  hashtagExtension,
  getTags,
  onPersist,
  onEditorReady,
}) {
  const saveTimeout = useRef(null)
  const pendingDoc = useRef(null)
  // What the editor serialized the moment the stream was rendered, keyed by
  // origin. The fork test is "differs from this", so it must always describe
  // exactly what is on screen — recaptured after every setContent, and a save
  // is refused while it is null (a reconcile against no baseline would read
  // every block as new writing and fork the whole stream).
  const baseline = useRef(null)
  const markerState = useRef({ show: true, forks: new Set() })
  const persistRef = useRef(onPersist)
  persistRef.current = onPersist
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId

  const streamHtml = useMemo(() => renderStreamHtml(entries), [entries])
  const forkOrigins = useMemo(
    () => new Set((entries || []).filter(e => e.isFork).map(e => e.origin)),
    [entries],
  )
  markerState.current = { show: !!showMarkers, forks: forkOrigins }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      ...(hashtagExtension ? [hashtagExtension] : []),
      HashtagSuggest.configure({ getTags }),
      RTLExtension,
      // Read path only: a clip captured from a journal day plays here, but its
      // delete/re-record controls are off — a note must not be able to change
      // the day it came from.
      AudioNode.configure({
        readOnly: true,
        getSource: () => ({
          sourceType: 'note',
          sourceId: noteIdRef.current || null,
          sourceTitle: noteTitle || '',
        }),
      }),
      BlockIdExtension,
      SearchHighlightExtension,
      StreamDateMarkers.configure({ getMarkerState: () => markerState.current }),
    ],
    content: streamHtml,
    onUpdate: ({ editor }) => {
      if (!baseline.current) return
      const serializer = DOMSerializer.fromSchema(editor.schema)
      pendingDoc.current = docToBlocks(editor.state.doc, serializer)
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        saveTimeout.current = null
        flush.current?.()
      }, STREAM_SAVE_DEBOUNCE_MS)
    },
  })

  const captureBaseline = useRef(null)
  captureBaseline.current = () => {
    if (!editor) return
    const serializer = DOMSerializer.fromSchema(editor.schema)
    baseline.current = buildBaseline(docToBlocks(editor.state.doc, serializer), entries)
  }

  // Flush the debounced edit: reconcile what is in the doc against the
  // baseline and hand the parent the blocks the note should hold. Same
  // hidden/pagehide/unmount discipline as the journal and note body editors —
  // mobile freezes the page on screen-off well before an 800ms debounce fires.
  const flush = useRef(null)
  flush.current = () => {
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current)
      saveTimeout.current = null
    }
    const docBlocks = pendingDoc.current
    pendingDoc.current = null
    if (!docBlocks || !baseline.current) return
    const result = reconcileStream({
      baseline: baseline.current,
      docBlocks,
      noteId: noteIdRef.current,
      today: today(),
      hiddenOrigins,
    })
    persistRef.current?.(result)
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
      flush.current?.()
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  // Re-render the stream when the store changes — a journal edit on another
  // device, a poll merge, our own fork landing. Same two guards as
  // JournalPanel: never rebuild the doc mid-type (setContent resets the
  // caret), and never rebuild when the editor already shows these entries.
  // The second test is content-equal rather than string-equal because a stored
  // fork serializes its attributes in ProseMirror's order while a freshly
  // captured source block gets them appended — same block, two spellings.
  useEffect(() => {
    if (!editor) return
    if (saveTimeout.current) return
    const serializer = DOMSerializer.fromSchema(editor.schema)
    if (streamMatchesEntries(docToBlocks(editor.state.doc, serializer), entries)) {
      // Still recapture: the baseline's provenance (src/date/isFork) comes from
      // the entries, which may have changed even when the html did not.
      captureBaseline.current?.()
      return
    }
    editor.commands.setContent(streamHtml, { emitUpdate: false })
    captureBaseline.current?.()
  }, [editor, streamHtml, entries])

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
    <div className="tag-stream">
      <div className="tag-stream-label">From the journal</div>
      {entries?.length ? (
        <EditorContent editor={editor} />
      ) : (
        <p className="tag-stream-empty">
          Nothing captured yet — write this tag in a journal entry and the paragraph shows up here.
        </p>
      )}
    </div>
  )
}
