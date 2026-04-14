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
  const [year, w] = week.split('-W')
  const y = parseInt(year), wn = parseInt(w)
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
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', fontSize: '14px', color: 'var(--text-primary)' }}>
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
      let doc = await getJournal(viewedWeek)
      if (!doc) doc = await pullJournal(viewedWeek)
      if (!doc) doc = { week: viewedWeek, entries: {} }
      setWeekDoc(doc)
    }
    load()
  }, [viewedWeek])

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
    const dates = buildWeekDates(viewedWeek)
    const anchor = new Date(dates[0] + 'T12:00:00')
    anchor.setDate(anchor.getDate() + delta * 7)
    const newWeek = weekKey(anchor.toISOString().slice(0, 10))
    setViewedWeek(newWeek)
    setSelectedDate(anchor.toISOString().slice(0, 10))
  }

  const entry = effectiveDoc?.entries?.[selectedDate]

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg-primary)' }}>
      {/* Date sidebar */}
      <div style={{
        width: '160px', flexShrink: 0,
        borderRight: '1px solid var(--border-light)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-light)',
        }}>
          <button
            onClick={() => goWeek(-1)}
            style={{ color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}
          >
            <ChevronLeft />
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500 }}>{viewedWeek}</span>
          <button
            onClick={() => goWeek(1)}
            style={{ color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}
          >
            <ChevronRight />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {weekDates.map(date => {
            const hasEntry = !!effectiveDoc?.entries?.[date]?.content
            const isToday = date === todayStr
            const isSelected = date === selectedDate
            return (
              <button
                key={date}
                onClick={() => setSelectedDate(date)}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '8px 12px', fontSize: '12px',
                  display: 'flex', alignItems: 'center', gap: '8px',
                  background: isSelected ? 'var(--bg-secondary)' : 'transparent',
                  borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: 'none', cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: hasEntry ? 'var(--accent)' : 'var(--border-mid)',
                }} />
                <span>
                  {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {isToday && <span style={{ marginLeft: '4px', color: 'var(--accent)' }}>·</span>}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-light)' }}>
          <h2 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)' }}>
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
  return <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><polyline points="15 18 9 12 15 6"/></svg>
}
function ChevronRight() {
  return <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><polyline points="9 18 15 12 9 6"/></svg>
}
