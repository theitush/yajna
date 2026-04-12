import { useState, useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import useAppStore from '../store/useAppStore'
import { today, weekKey, formatDate } from '../lib/dates'
import { getJournal } from '../services/db'
import { pullJournal } from '../services/sync'

function buildWeekDates(week) {
  // Parse YYYY-WWW
  const [year, w] = week.split('-W')
  const y = parseInt(year), wn = parseInt(w)
  // ISO week: find Jan 4th, get Monday of week 1
  const jan4 = new Date(y, 0, 4)
  const startOfWeek1 = new Date(jan4)
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  const weekStart = new Date(startOfWeek1)
  weekStart.setDate(startOfWeek1.getDate() + (wn - 1) * 7)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(weekStart.getDate() + i)
    return d.toISOString().slice(0, 10)
  })
}

const HashtagExtension = Extension.create({
  name: 'hashtag',
  addProseMirrorPlugins() {
    return [new Plugin({
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
              decorations.push(Decoration.inline(pos + match.index, pos + match.index + match[0].length, { class: 'hashtag' }))
            }
          })
          return DecorationSet.create(doc, decorations)
        },
      },
    })]
  },
})

function EntryEditor({ content, onSave }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Nothing written this day…' }),
      HashtagExtension,
    ],
    content: content || '',
    onUpdate: ({ editor }) => {
      onSave(editor.getHTML())
    },
  })

  useEffect(() => {
    if (!editor) return
    const current = editor.getHTML()
    if (current !== (content || '')) {
      editor.commands.setContent(content || '', false)
    }
  }, [content])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 text-sm text-gray-800 dark:text-gray-200">
      <EditorContent editor={editor} />
    </div>
  )
}

export default function JournalPage() {
  const currentJournal = useAppStore(s => s.currentJournal)
  const loadJournal = useAppStore(s => s.loadJournal)
  const updateJournalEntry = useAppStore(s => s.updateJournalEntry)
  const todayStr = today()
  const [selectedDate, setSelectedDate] = useState(todayStr)
  const [viewedWeek, setViewedWeek] = useState(weekKey(todayStr))
  const [weekDoc, setWeekDoc] = useState(null)
  const saveTimeout = useRef(null)

  useEffect(() => {
    async function load() {
      // Try local first, then Drive
      let doc = await getJournal(viewedWeek)
      if (!doc) {
        doc = await pullJournal(viewedWeek)
      }
      if (!doc) doc = { week: viewedWeek, entries: {} }
      setWeekDoc(doc)
    }
    load()
  }, [viewedWeek])

  // If current week, use store (stays in sync with TodayPage edits)
  const effectiveDoc = viewedWeek === weekKey(todayStr) ? currentJournal : weekDoc
  const weekDates = buildWeekDates(viewedWeek)

  const handleSave = (content) => {
    if (viewedWeek === weekKey(todayStr)) {
      clearTimeout(saveTimeout.current)
      saveTimeout.current = setTimeout(() => {
        updateJournalEntry(selectedDate, content)
      }, 800)
    }
  }

  const goWeek = (delta) => {
    const [y, w] = viewedWeek.split('-W')
    const newW = parseInt(w) + delta
    // simple: just shift by 7 days from first day of week
    const dates = buildWeekDates(viewedWeek)
    const anchor = new Date(dates[0] + 'T12:00:00')
    anchor.setDate(anchor.getDate() + delta * 7)
    const newWeek = weekKey(anchor.toISOString().slice(0, 10))
    setViewedWeek(newWeek)
    setSelectedDate(anchor.toISOString().slice(0, 10))
  }

  const entry = effectiveDoc?.entries?.[selectedDate]

  return (
    <div className="flex h-full">
      {/* Date list */}
      <div className="w-40 md:w-48 shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <button onClick={() => goWeek(-1)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1">
            <ChevronLeft />
          </button>
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{viewedWeek}</span>
          <button onClick={() => goWeek(1)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1">
            <ChevronRight />
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {weekDates.map(date => {
            const hasEntry = !!effectiveDoc?.entries?.[date]?.content
            const isToday = date === todayStr
            const isSelected = date === selectedDate
            return (
              <button
                key={date}
                onClick={() => setSelectedDate(date)}
                className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2 ${
                  isSelected
                    ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  hasEntry ? 'bg-violet-400' : 'bg-gray-200 dark:bg-gray-600'
                }`} />
                <span>
                  {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {isToday && <span className="ml-1 text-violet-500">·</span>}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            {formatDate(selectedDate)}
          </h2>
        </div>
        <EntryEditor
          key={selectedDate}
          content={entry?.content}
          onSave={handleSave}
        />
      </div>
    </div>
  )
}

function ChevronLeft() {
  return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><polyline points="15 18 9 12 15 6"/></svg>
}
function ChevronRight() {
  return <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><polyline points="9 18 15 12 9 6"/></svg>
}
