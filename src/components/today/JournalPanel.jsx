import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer } from '@tiptap/pm/model'
import { useEffect, useRef } from 'react'
import useAppStore from '../../store/useAppStore'
import { logSync } from '../../services/syncLog'
import { formatDate, currentJournalDay } from '../../lib/dates'
import EditorToolbar from '../editor/EditorToolbar'
import { RTLExtension } from '../editor/RTLExtension'
import { AudioNode } from '../editor/AudioNode'
import { BlockIdExtension } from '../editor/BlockIdExtension'
import { HashtagSuggest } from '../editor/HashtagSuggest'
import { HeadingNoShortcut } from '../editor/HeadingNoShortcut'
import RecordFab from '../voice/RecordFab'
import { docToBlocks, blocksToHtml } from '../../lib/blocks'

// How long to wait after the last keystroke before saving+pushing the journal.
// Each save triggers pushJournal (synchronous Automerge + Drive upload), so we
// only want it to fire when the user has genuinely PAUSED — not on the many
// sub-second micro-pauses inside normal writing. 800ms was short enough that
// ordinary typing rhythm fired a push every second or two; 2.5s rides through
// thinking pauses and only commits when you actually stop. Local IDB autosave
// safety isn't lost: the editor content is in memory and the next pause flushes
// it; a poll/merge never clobbers an unflushed edit (saveTimeout guards render).
const JOURNAL_SAVE_DEBOUNCE_MS = 2500

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
            const regex = /#[\w\u0590-\u05FF]+/g
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

export default function JournalPanel({ onInsertText, date, headerLabel }) {
  const currentDay = useAppStore(s => s.currentDay)
  // External-origin counter: bumps on navigation/load, sync-poll merge, or
  // audio restore — never on the editor's own debounced save. We key the
  // re-render effect on this so the editor renders genuine remote changes but
  // never reacts to the echo of its own write (the mid-type rebuild = lag).
  const currentDayRev = useAppStore(s => s.currentDayRev)
  const updateJournalEntry = useAppStore(s => s.updateJournalEntry)
  const loadJournal = useAppStore(s => s.loadJournal)
  const config = useAppStore(s => s.config)
  const getTags = useAppStore.getState().getAllTags
  const saveTimeout = useRef(null)
  // Latest unsaved payload, captured each onUpdate. With a longer debounce the
  // window where edits sit unsaved is bigger, so we flush this on unmount and on
  // day-change to guarantee the tail of writing isn't lost if you navigate away
  // before the debounce fires.
  const pendingSave = useRef(null)
  const targetDate = date || currentJournalDay(config)

  useEffect(() => {
    loadJournal(targetDate)
  }, [targetDate])

  // Flush any pending (debounced-but-not-yet-saved) edit when the panel
  // unmounts or the day changes, so the tail of writing survives navigation.
  // Cleanup runs before the next targetDate's load, so we save the OLD day's
  // pending payload using the date captured in pendingSave, not targetDate.
  useEffect(() => {
    return () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current)
        saveTimeout.current = null
      }
      const p = pendingSave.current
      if (p) {
        pendingSave.current = null
        updateJournalEntry(p.date, { html: p.html, blocks: p.blocks })
      }
    }
  }, [targetDate])

  const dayDoc = currentDay?.date === targetDate ? currentDay : null
  const content = (dayDoc ? blocksToHtml(dayDoc.blocks) : '') || ''

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      HashtagExtension,
      HashtagSuggest.configure({ getTags }),
      RTLExtension,
      AudioNode.configure({
        getSource: () => ({
          sourceType: 'journal',
          sourceId: targetDate,
          sourceTitle: formatDate(targetDate),
        }),
      }),
      BlockIdExtension,
    ],
    content,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      const serializer = DOMSerializer.fromSchema(editor.schema)
      const blocks = docToBlocks(editor.state.doc, serializer)
      pendingSave.current = { date: targetDate, html, blocks }
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        saveTimeout.current = null
        pendingSave.current = null
        // Bumps currentDay but NOT currentDayRev, so this save never re-fires
        // the render effect below — the editor doesn't rebuild on its own echo.
        // [lag-debug] local save: should NOT be followed by a 'render setContent'.
        logSync('lag: local save', { len: html.length })
        updateJournalEntry(targetDate, { html, blocks })
      }, JOURNAL_SAVE_DEBOUNCE_MS)
    },
  })

  // Render external changes into the editor. Keyed on currentDayRev (bumped
  // only by navigation/load, sync-poll merge, or audio restore), so the effect
  // runs for genuine remote content and never for the echo of our own save.
  useEffect(() => {
    if (!editor) return
    const remoteContent = dayDoc ? blocksToHtml(dayDoc.blocks) : ''
    if (!remoteContent) return
    // Don't rebuild the doc while the user is mid-type: a setContent resets the
    // cursor. A pending debounced save IS the "actively typing" signal — once it
    // fires and clears, the user has paused and the next poll (or this effect's
    // re-run on the save's external echo) renders the remote change safely.
    // setContent is TipTap's own cursor-free reconcile, so a clean reset is the
    // right primitive — no hand-rolled position math.
    if (saveTimeout.current) {
      // [lag-debug] external bump arrived mid-type → deferred, no rebuild now.
      logSync('lag: render deferred (mid-type)', { rev: currentDayRev })
      return
    }
    if (editor.getHTML() === remoteContent) {
      // [lag-debug] rev bumped but content already matches → no rebuild. If this
      // fires right after a 'local save', the own-echo path is misrouting.
      logSync('lag: render skip (content equal)', { rev: currentDayRev })
      return
    }
    // [lag-debug] a real remote change rendering in. Should NEVER appear right
    // after your OWN 'local save' — only on navigation/poll-merge from device B.
    logSync('lag: render setContent', { rev: currentDayRev, len: remoteContent.length })
    editor.commands.setContent(remoteContent, { emitUpdate: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, currentDayRev])

  useEffect(() => {
    if (!onInsertText) return
    onInsertText.current = (text) => {
      if (!editor) return
      editor.commands.focus()
      editor.commands.insertContent(text)
    }
  }, [editor, onInsertText])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 20px',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)' }}>
          {headerLabel ?? formatDate(targetDate)}
        </span>
      </div>

      <EditorToolbar editor={editor} />

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 22rem' }}>
        <EditorContent editor={editor} />
      </div>
      {editor && <RecordFab editor={editor} />}
    </div>
  )
}
