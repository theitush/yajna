import { useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useNavigate, useSearchParams } from 'react-router-dom'
import useAppStore from '../store/useAppStore'
import { getAllJournals, getAllAudio } from '../services/db'
import { audioIdsFromBlocks, blocksToPlainText, blocksWithText, buildSearchableText, snippetAround } from '../lib/search'
import SearchGroup from '../components/search/SearchGroup'
import Highlighted from '../components/search/Highlighted'

const FUSE_OPTS = {
  includeMatches: true,
  ignoreLocation: true,
  threshold: 0.35,
  minMatchCharLength: 2,
  keys: [
    { name: 'title', weight: 0.6 },
    { name: 'body', weight: 0.4 },
  ],
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!isFinite(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const cardStyle = {
  background: 'var(--bg-primary)',
  border: '1px solid var(--border-light)',
  borderRadius: '10px',
  padding: '10px 12px',
  cursor: 'pointer',
  display: 'flex', flexDirection: 'column', gap: '4px',
  textAlign: 'start',
}

// Pull match indices for a specific key off a Fuse result.
function matchesFor(result, key) {
  const m = (result.matches || []).find(x => x.key === key)
  return m?.indices || []
}

function DoneCheck() {
  return (
    <span
      aria-hidden
      style={{
        width: 14, height: 14, borderRadius: '50%',
        background: 'var(--green-500)',
        flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 0 0 2px rgba(16,185,129,0.2)',
      }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  )
}

function ResultRow({ title, titleIndices, snippet, snippetIndices, meta, onClick, leadingIcon, titleStrike }) {
  return (
    <button onClick={onClick} style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }} dir="auto">
        {leadingIcon}
        <span style={{
          textDecoration: titleStrike ? 'line-through' : 'none',
          color: titleStrike ? 'var(--green-800)' : undefined,
        }}>
          <Highlighted text={title || '(untitled)'} indices={titleIndices} />
        </span>
      </div>
      {snippet && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }} dir="auto">
          <Highlighted text={snippet} indices={snippetIndices} />
        </div>
      )}
      {meta && (
        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{meta}</div>
      )}
    </button>
  )
}

export default function SearchPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') || ''
  const inputRef = useRef(null)

  const tasks = useAppStore(s => s.tasks)
  const notes = useAppStore(s => s.notes)
  const trashedTasks = useAppStore(s => s.trashedTasks)
  const trashedNotes = useAppStore(s => s.trashedNotes)
  const trashedAudio = useAppStore(s => s.trashedAudio)
  const reviewVersion = useAppStore(s => s.reviewVersion)
  const loadTrash = useAppStore(s => s.loadTrash)

  const [journalDocs, setJournalDocs] = useState([])
  const [audioMap, setAudioMap] = useState({})

  useEffect(() => {
    loadTrash().catch(() => {})
  }, [loadTrash])

  useEffect(() => {
    let active = true
    Promise.all([getAllJournals(), getAllAudio()]).then(([docs, audio]) => {
      if (!active) return
      setJournalDocs(docs || [])
      const map = {}
      for (const a of audio || []) {
        if (a?.transcript) map[a.id] = a.transcript
      }
      setAudioMap(map)
    }).catch(() => {})
    return () => { active = false }
  }, [reviewVersion])

  useEffect(() => { inputRef.current?.focus() }, [])

  const setQuery = (next) => {
    const p = new URLSearchParams(params)
    if (next) p.set('q', next); else p.delete('q')
    setParams(p, { replace: true })
  }

  // Per-block indexing: every block gets its own search doc so a hit can
  // navigate to the exact paragraph. Same date/title appearing in multiple
  // rows is intentional — each row has a different snippet.
  const journalDocsForSearch = useMemo(() => {
    const out = []
    for (const doc of journalDocs) {
      if (!doc?.date) continue
      const date = doc.date
      const blocks = blocksWithText(doc.blocks)
      for (const b of blocks) {
        const audioTexts = b.audioIds.map(id => audioMap[id]).filter(Boolean)
        const body = buildSearchableText([b.text, ...audioTexts])
        if (!body) continue
        out.push({
          kind: 'journal',
          id: `${date}:${b.blockId || ''}`,
          title: fmtDate(date) || date,
          body,
          date,
          blockId: b.blockId,
          reviewedAt: doc.reviewedAt || null,
        })
      }
    }
    return out
  }, [journalDocs, audioMap])

  const notesForSearch = useMemo(() => {
    const out = []
    for (const n of notes) {
      const blocks = blocksWithText(n.blocks)
      const tagText = (n.tags || []).map(t => `#${t}`).join(' ')
      // One row per block so we can land on the exact paragraph; tags
      // hitch-hike on the first block (or a synthetic if there are none).
      if (blocks.length === 0) {
        if (!tagText) continue
        out.push({
          kind: 'note',
          id: `${n.id}:`,
          title: n.title || 'Untitled',
          body: tagText,
          noteId: n.id,
          blockId: null,
          updatedAt: n.updatedAt,
          tags: n.tags || [],
        })
        continue
      }
      blocks.forEach((b, i) => {
        const audioTexts = b.audioIds.map(id => audioMap[id]).filter(Boolean)
        const body = buildSearchableText([b.text, ...audioTexts, i === 0 ? tagText : ''])
        if (!body) return
        out.push({
          kind: 'note',
          id: `${n.id}:${b.blockId || i}`,
          title: n.title || 'Untitled',
          body,
          noteId: n.id,
          blockId: b.blockId,
          updatedAt: n.updatedAt,
          tags: n.tags || [],
        })
      })
    }
    return out
  }, [notes, audioMap])

  const todosForSearch = useMemo(() => tasks.map(t => ({
    kind: 'todo',
    id: t.id,
    title: t.title || '',
    body: buildSearchableText([t.explanation || '', t.feedback || '', t.tags || '']),
    status: t.status,
    updatedAt: t.updatedAt,
  })), [tasks])

  const trashForSearch = useMemo(() => {
    const out = []
    for (const t of trashedTasks) {
      out.push({
        kind: 'trash',
        subKind: 'todo',
        id: t.id,
        title: t.title || '(untitled task)',
        body: buildSearchableText([t.explanation || '', t.feedback || '', t.tags || '']),
        deletedAt: t.deletedAt,
      })
    }
    for (const n of trashedNotes) {
      const bodyText = blocksToPlainText(n.blocks)
      const audioTexts = audioIdsFromBlocks(n.blocks).map(id => audioMap[id]).filter(Boolean)
      out.push({
        kind: 'trash',
        subKind: 'note',
        id: n.id,
        title: n.title || 'Untitled',
        body: buildSearchableText([bodyText, ...audioTexts]),
        deletedAt: n.deletedAt,
      })
    }
    for (const a of trashedAudio) {
      if (!a.transcript) continue
      out.push({
        kind: 'trash',
        subKind: 'audio',
        id: a.id,
        title: `Audio · ${fmtDate(a.createdAt) || 'recording'}`,
        body: a.transcript,
        deletedAt: a.deletedAt,
      })
    }
    return out
  }, [trashedTasks, trashedNotes, trashedAudio, audioMap])

  const journalFuse = useMemo(() => new Fuse(journalDocsForSearch, FUSE_OPTS), [journalDocsForSearch])
  const notesFuse = useMemo(() => new Fuse(notesForSearch, FUSE_OPTS), [notesForSearch])
  const todosFuse = useMemo(() => new Fuse(todosForSearch, FUSE_OPTS), [todosForSearch])
  const trashFuse = useMemo(() => new Fuse(trashForSearch, FUSE_OPTS), [trashForSearch])

  const trimmed = q.trim()
  const journalResults = useMemo(() => trimmed ? journalFuse.search(trimmed) : [], [journalFuse, trimmed])
  const rawNotesResults = useMemo(() => trimmed ? notesFuse.search(trimmed) : [], [notesFuse, trimmed])
  const todosResults = useMemo(() => trimmed ? todosFuse.search(trimmed) : [], [todosFuse, trimmed])
  const trashResults = useMemo(() => trimmed ? trashFuse.search(trimmed) : [], [trashFuse, trimmed])

  // Dedupe note rows by noteId. A query can match many blocks of the same
  // note; a single card per note is friendlier than a wall of duplicates.
  // For each note we keep the best body hit (first ranked Fuse result that
  // actually has body match indices). If only the title matched, we fall
  // back to the first block as a teaser.
  const notesResults = useMemo(() => {
    const byNote = new Map()
    for (const r of rawNotesResults) {
      const noteId = r.item.noteId
      const hasBody = (r.matches || []).some(m => m.key === 'body' && m.indices?.length)
      const existing = byNote.get(noteId)
      if (!existing) {
        byNote.set(noteId, { rep: r, bodyHit: hasBody ? r : null })
      } else if (hasBody && !existing.bodyHit) {
        existing.bodyHit = r
      }
    }
    return [...byNote.values()].map(({ rep, bodyHit }) => ({ rep, bodyHit }))
  }, [rawNotesResults])

  const renderResults = (results, onPick) => results.map((r, i) => {
    const titleIdx = matchesFor(r, 'title')
    const bodyIdx = matchesFor(r, 'body')
    const snip = snippetAround(r.item.body || '', bodyIdx)
    const isDoneTodo = r.item.kind === 'todo' && (r.item.status === 'done' || r.item.status === 'reviewed')
    return (
      <ResultRow
        key={r.item.kind + ':' + r.item.id + ':' + i}
        title={r.item.title}
        titleIndices={titleIdx}
        snippet={snip.text}
        snippetIndices={snip.indices}
        leadingIcon={isDoneTodo ? <DoneCheck /> : null}
        titleStrike={isDoneTodo}
        meta={r.item.kind === 'journal'
          ? (r.item.reviewedAt ? 'Reviewed' : 'Journal entry')
          : r.item.kind === 'todo'
            ? `Status: ${r.item.status || 'active'}`
            : r.item.subKind === 'audio'
              ? 'Audio transcript'
              : r.item.subKind === 'note'
                ? 'Trashed note'
                : 'Trashed todo'}
        onClick={() => onPick(r.item)}
      />
    )
  })

  // Notes get their own renderer because we dedupe by noteId and the
  // snippet should come from the body-matching block, falling back to a
  // teaser of the first block (title-only hit).
  const renderNoteResults = (groups) => groups.map((g, i) => {
    const rep = g.rep
    const titleIdx = matchesFor(rep, 'title')
    let snippet = ''
    let snippetIdx = []
    let target = rep.item
    if (g.bodyHit) {
      const bodyIdx = matchesFor(g.bodyHit, 'body')
      const snip = snippetAround(g.bodyHit.item.body || '', bodyIdx)
      snippet = snip.text
      snippetIdx = snip.indices
      target = g.bodyHit.item
    } else {
      // Title-only hit: teaser is the first block of the note, ellipsised.
      const firstRow = rawNotesResults.find(r => r.item.noteId === rep.item.noteId)
      const first = firstRow?.item.body || rep.item.body || ''
      const radius = 60
      if (first) {
        const slice = first.length > radius * 2 ? first.slice(0, radius * 2) + '…' : first
        snippet = slice
        snippetIdx = []
      }
    }
    return (
      <ResultRow
        key={'note:' + rep.item.noteId + ':' + i}
        title={rep.item.title}
        titleIndices={titleIdx}
        snippet={snippet}
        snippetIndices={snippetIdx}
        meta={rep.item.tags?.length ? rep.item.tags.map(t => `#${t}`).join(' ') : null}
        onClick={() => goToNote(target)}
      />
    )
  })

  const goToJournal = (item) => {
    const parts = [`date=${encodeURIComponent(item.date)}`]
    if (item.blockId) parts.push(`block=${encodeURIComponent(item.blockId)}`)
    navigate(`/review?${parts.join('&')}`)
  }
  const goToNote = (item) => {
    const parts = [`id=${encodeURIComponent(item.noteId || item.id)}`]
    if (item.blockId) parts.push(`block=${encodeURIComponent(item.blockId)}`)
    navigate(`/notes?${parts.join('&')}`)
  }
  const goToTodo = (item) => navigate(`/tasks?id=${encodeURIComponent(item.id)}`)
  const goToTrash = (item) => {
    const parts = []
    if (item?.id) parts.push(`id=${encodeURIComponent(item.id)}`)
    if (item?.subKind) parts.push(`kind=${encodeURIComponent(item.subKind)}`)
    navigate(parts.length ? `/trash?${parts.join('&')}` : '/trash')
  }

  const hasQuery = !!trimmed
  const uniqueNotesCount = new Set(notesForSearch.map(n => n.noteId)).size
  const totalCount = journalResults.length + notesResults.length + todosResults.length + trashResults.length

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-light)',
        position: 'sticky', top: 0,
        background: 'var(--bg-primary)', zIndex: 10,
      }}>
        <h1 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)', flexShrink: 0 }}>Search</h1>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, maxWidth: '420px', margin: '0 auto' }}>
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setQuery('') }}
            placeholder="Search everything…"
            dir="auto"
            style={{
              width: '100%', fontSize: '13px',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-mid)',
              borderRadius: '8px', padding: '8px 12px',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-body)',
              outline: 'none',
            }}
          />
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {hasQuery ? `${totalCount} match${totalCount === 1 ? '' : 'es'}` : ''}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
        {!hasQuery && (
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '12px' }}>
            Type to search across journal entries, notes, todos, and trash.
          </p>
        )}

        <SearchGroup
          id="journal"
          label="Journal & Reviews"
          count={hasQuery ? journalResults.length : journalDocsForSearch.length}
          defaultOpen={true}
        >
          {renderResults(journalResults, goToJournal)}
        </SearchGroup>

        <SearchGroup
          id="notes"
          label="Notes"
          count={hasQuery ? notesResults.length : uniqueNotesCount}
          defaultOpen={true}
        >
          {renderNoteResults(notesResults)}
        </SearchGroup>

        <SearchGroup
          id="todos"
          label="Todos"
          count={hasQuery ? todosResults.length : todosForSearch.length}
          defaultOpen={true}
        >
          {renderResults(todosResults, goToTodo)}
        </SearchGroup>

        <SearchGroup
          id="trash"
          label="Trash"
          count={hasQuery ? trashResults.length : trashForSearch.length}
          defaultOpen={false}
        >
          {renderResults(trashResults, goToTrash)}
        </SearchGroup>
      </div>
    </div>
  )
}
