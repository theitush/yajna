/**
 * Region A of a tag-note: the note's OWN body.
 *
 * Only the blocks the note itself holds that are not captured paragraphs —
 * the stream (Region B, TagNoteStream) owns those. The editor never sees the
 * note row: its parent hands it the html to show and takes the blocks back,
 * which is what lets a tag with no stored row yet show an empty body and mint
 * the row on the first keystroke.
 */
import { useEffect, useRef } from 'react'
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
import './tagNotes.css'

const NOTE_SAVE_DEBOUNCE_MS = 800

export default function NoteBodyEditor({
  content,
  noteId,
  noteTitle,
  hashtagExtension,
  getTags,
  onSave,
  onEditorReady,
}) {
  const saveTimeout = useRef(null)
  // Latest unsaved body, so it can be flushed when the editor unmounts, the
  // selection changes, or the tab is hidden/unloaded — on mobile the page
  // freezes on screen-off well before the debounce fires.
  const pendingSave = useRef(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId

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
      AudioNode.configure({
        getSource: () => ({
          sourceType: 'note',
          sourceId: noteIdRef.current || null,
          sourceTitle: noteTitle || '',
        }),
      }),
      BlockIdExtension,
      SearchHighlightExtension,
    ],
    content: content || '',
    onUpdate: ({ editor }) => {
      const serializer = DOMSerializer.fromSchema(editor.schema)
      const blocks = docToBlocks(editor.state.doc, serializer)
      const tags = extractHashtags(editor.getText())
      pendingSave.current = { blocks, tags }
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        saveTimeout.current = null
        pendingSave.current = null
        saveRef.current?.({ blocks, tags })
      }, NOTE_SAVE_DEBOUNCE_MS)
    },
  })

  const flushPending = useRef(null)
  flushPending.current = () => {
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current)
      saveTimeout.current = null
    }
    const p = pendingSave.current
    if (!p) return
    pendingSave.current = null
    saveRef.current?.(p)
  }

  useEffect(() => {
    const flush = () => flushPending.current?.()
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      // Runs on unmount and before each selection switch (the parent keys this
      // component on the selection), so the tail of an edit lands on the note
      // it was typed into — saveRef still holds that selection's handler.
      flush()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  // Reconcile against the store, with JournalPanel's two guards: never while
  // mid-type (setContent resets the caret), never when already identical (the
  // echo of our own save).
  useEffect(() => {
    if (!editor) return
    if (saveTimeout.current) return
    const next = content || ''
    if (editor.getHTML() === next) return
    editor.commands.setContent(next, { emitUpdate: false })
  }, [editor, content])

  useEffect(() => {
    onEditorReady?.(editor || null)
    return () => onEditorReady?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  return (
    <div className="tag-note-body">
      <EditorContent editor={editor} />
    </div>
  )
}
