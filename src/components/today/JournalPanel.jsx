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
import { formatDate } from '../../lib/dates'
import useCurrentDay from '../../lib/useCurrentDay'
import EditorToolbar from '../editor/EditorToolbar'
import { RTLExtension } from '../editor/RTLExtension'
import { AudioNode } from '../editor/AudioNode'
import { BlockIdExtension } from '../editor/BlockIdExtension'
import { HashtagSuggest } from '../editor/HashtagSuggest'
import { HeadingNoShortcut } from '../editor/HeadingNoShortcut'
import RecordFab from '../voice/RecordFab'
import { docToBlocks, blocksToHtml } from '../../lib/blocks'
import { logSync } from '../../services/syncLog'

// How long to wait after the last keystroke before saving+pushing the journal.
// The push's Automerge work now runs in a worker (automergeWorkerClient), so a
// save never freezes the editor — the debounce no longer masks lag, it just
// trims redundant Drive writes (and the sidebar status-dot flicker that comes
// with each push). 1.2s keeps cross-device sync responsive while staying calm
// during a normal typing burst. Bursts can't pile up regardless: executePush in
// syncEngine is single-flight + coalescing — at most one push runs and one (the
// LATEST) is queued behind it; intermediate snapshots are dropped, which loses
// nothing because pushJournal always writes the current full row, not a diff.
const JOURNAL_SAVE_DEBOUNCE_MS = 1200

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
  const liveDay = useCurrentDay(config)
  const targetDate = date || liveDay

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        updateJournalEntry(targetDate, { html, blocks })
      }, JOURNAL_SAVE_DEBOUNCE_MS)
    },
  })

  // Flush the pending debounced edit when the tab is hidden or the page is
  // being unloaded — on mobile the OS freezes the page's JS within seconds of
  // screen-off, before the 1.2s debounce can fire, so without this the tail of
  // writing is lost (the screen-off data-loss report, 2026-06-02). The unmount
  // effect above doesn't cover backgrounding because the component stays mounted
  // when the tab is merely hidden. updateJournalEntry kicks off the local save
  // synchronously (IDB write is async but enqueued before freeze); the push
  // rides the next resume until sync-core lands. visibilitychange(hidden) is the
  // reliable mobile signal; pagehide covers desktop tab-close / bfcache.
  useEffect(() => {
    const flush = () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current)
        saveTimeout.current = null
      }
      const p = pendingSave.current
      if (!p) return
      pendingSave.current = null
      updateJournalEntry(p.date, { html: p.html, blocks: p.blocks })
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Render external changes into the editor. Keyed on the STORE CONTENT itself
  // (`content`), not only on the `currentDayRev` side-channel counter.
  //
  // Why: the editor's source of truth is the store's currentDay. currentDayRev
  // was a hand-bumped "external origin" signal, but a poll-merge only bumps it
  // when the merge changed content vs the store (syncEngine contentChanged
  // guard). Once the editor drifts behind a store that already matches Drive —
  // e.g. the store updated while we were mid-type, or a rev bump landed during a
  // setContent race — every later poll sees store==Drive (blocksChanged:false),
  // never bumps rev, so this effect never re-ran and the editor stayed frozen
  // until a FOREIGN write finally flipped the rev gate. That is the "stale on
  // phone, fresh the instant I opened the laptop" bug (proven 2026-06-08: store
  // remoteLen 4403 vs editor editorLen 3444 for the whole stale window).
  // Depending on the actual rendered content makes this a reconcile-against-
  // source, so it re-checks whenever the store text changes — no writer has to
  // remember to bump a counter. currentDayRev stays in deps so navigation/audio-
  // restore can force a repaint even when the string is unchanged. This does NOT
  // reintroduce the typing lag (the worker/debounce work): the two guards below
  // still bail on mid-type (no cursor reset) and on identical content (no
  // rebuild on our own save echo) regardless of what triggered the effect.
  useEffect(() => {
    if (!editor) return
    const remoteContent = dayDoc ? blocksToHtml(dayDoc.blocks) : ''
    // Probe: this effect is the LAST mile — a poll-merged remote journal only
    // reaches the screen if it runs setContent here. Log every exit reason
    // (lengths only, no entry text) so the "didn't appear on phone" reports can
    // finally be traced end to end: merge (Probe 1) → render decision (Probe 2)
    // → this paint.
    const reason =
      !remoteContent ? 'empty-remote'
      : saveTimeout.current ? 'mid-type'
      : editor.getHTML() === remoteContent ? 'identical'
      : 'applied'
    logSync('journal render effect', {
      date: targetDate,
      rev: currentDayRev,
      reason,
      remoteLen: remoteContent.length,
      editorLen: editor.getHTML().length,
    })
    if (!remoteContent) return
    // Don't rebuild the doc while the user is mid-type: a setContent resets the
    // cursor. A pending debounced save IS the "actively typing" signal — once it
    // fires and clears, the user has paused and the next poll (or this effect's
    // re-run on the save's external echo) renders the remote change safely.
    // setContent is TipTap's own cursor-free reconcile, so a clean reset is the
    // right primitive — no hand-rolled position math.
    if (saveTimeout.current) return
    if (editor.getHTML() === remoteContent) return
    editor.commands.setContent(remoteContent, { emitUpdate: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, content, currentDayRev])

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
