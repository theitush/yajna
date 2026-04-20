import { useState, useRef, useEffect, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import { today } from '../../lib/dates'
import HashtagTextarea from '../HashtagAutocomplete'
import TagSelector from '../TagSelector'

const HASHTAG_RE = /(#[\p{L}\p{N}_-]+)/gu

function renderWithHashtags(text) {
  if (!text) return text
  const parts = text.split(HASHTAG_RE)
  return parts.map((part, i) =>
    part.startsWith('#')
      ? <span key={i} style={{ color: 'var(--accent)', fontWeight: 500 }}>{part}</span>
      : part
  )
}

export default function TaskCard({ task, defaultExpanded = false, defaultEditingTitle = false }) {
  const { markTaskDone, markTaskActive, markTaskReviewed, deleteTask, moveToBacklog, scheduleTask, updateTask } = useAppStore()
  // Subscribe to anything that can change the tag pool, then ask the store.
  useAppStore(s => s.notes)
  useAppStore(s => s.tasks)
  useAppStore(s => s.currentJournal)
  useAppStore(s => s.journalTagPool)
  const allTags = useAppStore.getState().getAllTags()
  const [showReschedule, setShowReschedule] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [editingTitle, setEditingTitle] = useState(defaultEditingTitle)
  const [editExplanation, setEditExplanation] = useState(task.explanation || '')
  const [editFeedback, setEditFeedback] = useState(task.feedback || '')
  const [editTags, setEditTags] = useState(task.tags || '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const cardRef = useRef(null)
  const titleRef = useRef(null)
  const explanationRef = useRef(null)
  const feedbackRef = useRef(null)
  const tagInputRef = useRef(null)

  const autosize = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  useEffect(() => {
    if (expanded) {
      autosize(explanationRef.current)
      autosize(feedbackRef.current)
    }
  }, [expanded, editExplanation, editFeedback, editTags])

  useEffect(() => {
    if (defaultExpanded) setExpanded(true)
    if (defaultEditingTitle) setEditingTitle(true)
  }, [defaultExpanded, defaultEditingTitle])

  useEffect(() => {
    if (!editingTitle || !titleRef.current) return
    const el = titleRef.current
    el.focus()
    const range = document.createRange()
    const sel = window.getSelection()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTitle])

  const isDone = task.status === 'done' || task.status === 'reviewed'

  useEffect(() => {
    setEditExplanation(task.explanation || '')
    setEditFeedback(task.feedback || '')
    setEditTags(task.tags || '')
  }, [task.explanation, task.feedback, task.tags])

  const commitEdits = useCallback(() => {
    const titleVal = titleRef.current?.innerText.trim() ?? ''
    if (!titleVal && !editExplanation.trim() && !editFeedback.trim() && !editTags.trim()) {
      deleteTask(task.id)
      return
    }
    updateTask(task.id, {
      ...(titleVal && titleVal !== task.title ? { title: titleVal } : {}),
      explanation: editExplanation.trim(),
      feedback: editFeedback.trim(),
      tags: editTags.trim(),
    })
    setExpanded(false)
    setEditingTitle(false)
    setShowReschedule(false)
    setConfirmDelete(false)
  }, [editExplanation, editFeedback, editTags, task.id, task.title, updateTask, deleteTask])

  const handleClickOutside = useCallback((e) => {
    if (cardRef.current && !cardRef.current.contains(e.target)) {
      commitEdits()
    }
  }, [commitEdits])

  const handleEditKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commitEdits()
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      tagInputRef.current?.focus()
    }
  }

  const handleExplanationKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commitEdits()
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      feedbackRef.current?.focus()
    }
  }

  useEffect(() => {
    if (expanded) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('touchstart', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [expanded, handleClickOutside])

  useEffect(() => {
    if (!expanded) return
    const handleGlobalKey = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        commitEdits()
      }
    }
    document.addEventListener('keydown', handleGlobalKey)
    return () => document.removeEventListener('keydown', handleGlobalKey)
  }, [expanded, commitEdits])

  const handleCheckmark = () => {
    if (isDone) markTaskActive(task.id)
    else markTaskDone(task.id)
  }

  const handleTitleBlur = () => {
    const val = titleRef.current?.innerText.trim()
    if (val && val !== task.title) {
      updateTask(task.id, { title: val })
    }
    setEditingTitle(false)
  }

  const handleTitleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdits()
    }
    if (e.key === 'Escape') {
      titleRef.current?.blur()
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      const val = titleRef.current?.innerText.trim() ?? ''
      if (val && val !== task.title) updateTask(task.id, { title: val })
      setEditingTitle(false)
      explanationRef.current?.focus()
    }
  }

  const handleTitleDoubleClick = (e) => {
    e.stopPropagation()
    setEditingTitle(true)
  }

  const handleSchedule = () => {
    if (scheduleDate) {
      scheduleTask(task.id, scheduleDate)
      setShowReschedule(false)
    }
  }

  const handleX = () => {
    if (isDone) {
      markTaskReviewed(task.id)
    } else {
      setConfirmDelete(true)
    }
  }

  const openExpanded = () => {
    setExpanded(true)
  }

  const cardStyle = {
    borderRadius: '12px',
    border: isDone
      ? '1px solid rgba(16,185,129,0.25)'
      : '1px solid var(--border-light)',
    background: isDone
      ? 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(16,185,129,0.04) 100%)'
      : 'var(--bg-primary)',
    position: 'relative',
    transition: 'border-color 0.2s',
  }

  const textareaStyle = {
    width: '100%',
    fontSize: '12px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: '8px',
    padding: '8px 12px',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-body)',
    outline: 'none',
    resize: 'none',
  }

  return (
    <div ref={cardRef} style={cardStyle}>
      {/* Header row */}
      <div
        onClick={(e) => {
          const tag = e.target.tagName.toLowerCase()
          if (tag === 'button' || e.target.isContentEditable || editingTitle) return
          if (expanded) commitEdits()
          else setExpanded(true)
        }}
        style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px 16px', paddingBottom: expanded ? '8px' : '14px' }}
      >
        {/* Checkmark */}
        <button
          onClick={handleCheckmark}
          tabIndex={-1}
          style={{
            width: 22, height: 22,
            borderRadius: '50%',
            border: isDone ? 'none' : '2px solid var(--border-mid)',
            background: isDone ? 'var(--green-500)' : 'transparent',
            flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: isDone ? '0 0 0 3px rgba(16,185,129,0.2), 0 2px 12px rgba(16,185,129,0.35)' : 'none',
            transition: 'all 0.2s',
          }}
          aria-label={isDone ? 'Mark as active' : 'Mark as done'}
        >
          {isDone && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>

        {/* Title */}
        <span
          key={editingTitle ? 'edit' : 'view'}
          ref={titleRef}
          dir="auto"
          contentEditable={editingTitle ? 'true' : 'false'}
          suppressContentEditableWarning
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKey}
          onDoubleClick={handleTitleDoubleClick}
          onClick={expanded && !editingTitle ? handleTitleDoubleClick : undefined}
          style={{
            flex: 1,
            fontSize: '14px',
            fontWeight: 500,
            color: isDone ? 'var(--green-800)' : 'var(--text-primary)',
            lineHeight: 1.4,
            outline: 'none',
            cursor: editingTitle ? 'text' : 'default',
            textDecoration: isDone ? 'line-through' : 'none',
            borderRadius: editingTitle ? '4px' : 'none',
            boxShadow: editingTitle ? '0 0 0 2px var(--accent)' : 'none',
            padding: editingTitle ? '1px 3px' : '0',
            margin: editingTitle ? '-1px -3px' : '0',
          }}
        >
          {editingTitle ? task.title : renderWithHashtags(task.title)}
        </span>

        {/* Status badges */}
        {!expanded && task.status === 'scheduled' && (
          <span style={{
            fontSize: '11px', padding: '2px 8px', borderRadius: '20px', fontWeight: 500, flexShrink: 0,
            background: 'rgba(245,158,11,0.15)', color: '#FCD34D', border: '1px solid rgba(245,158,11,0.3)',
          }}>
            {task.scheduledDate}
          </span>
        )}
        {!expanded && task.status === 'backlog' && (
          <span style={{
            fontSize: '11px', padding: '2px 8px', borderRadius: '20px', fontWeight: 500, flexShrink: 0,
            background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-light)',
          }}>
            backlog
          </span>
        )}

        {/* X button */}
        {task.status !== 'dismissed' && task.status !== 'reviewed' && (
          <button
            onClick={handleX}
            tabIndex={-1}
            style={{
              flexShrink: 0,
              color: isDone ? 'var(--green-400)' : 'var(--text-tertiary)',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '16px', lineHeight: 1,
              transition: 'color 0.15s',
            }}
            aria-label={isDone ? 'Mark as reviewed' : 'Delete task'}
          >
            ×
          </button>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div style={{ padding: '0 16px 12px', paddingLeft: '50px', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => deleteTask(task.id)}
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
      )}

      {/* Collapsed preview */}
      {!expanded && !confirmDelete && (task.explanation || task.feedback || task.tags) && (
        <button onClick={openExpanded} style={{ width: '100%', textAlign: 'start', padding: '0 16px 12px', paddingLeft: '50px', background: 'none', border: 'none', cursor: 'pointer' }}>
          {task.explanation && (
            <p dir="auto" style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textAlign: 'start' }}>
              {renderWithHashtags(task.explanation)}
            </p>
          )}
          {task.feedback && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border-light)', margin: '6px 0 4px' }} />
              <p dir="auto" style={{ fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textAlign: 'start' }}>
                {renderWithHashtags(task.feedback)}
              </p>
            </>
          )}
          {task.tags && (
            <p dir="auto" style={{ fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textAlign: 'start', marginTop: '4px' }}>
              {renderWithHashtags(task.tags)}
            </p>
          )}
        </button>
      )}

      {/* Expanded editable */}
      {expanded && (
        <div style={{ padding: '0 16px 14px', paddingLeft: '50px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <textarea
            ref={explanationRef}
            value={editExplanation}
            onChange={e => setEditExplanation(e.target.value)}
            onKeyDown={handleExplanationKey}
            rows={1}
            placeholder="Explanation…"
            dir="auto"
            style={{ ...textareaStyle, overflow: 'hidden' }}
          />
          <textarea
            ref={feedbackRef}
            value={editFeedback}
            onChange={e => setEditFeedback(e.target.value)}
            onKeyDown={handleEditKey}
            rows={1}
            placeholder="Feedback…"
            dir="auto"
            style={{ ...textareaStyle, opacity: 0.8, overflow: 'hidden' }}
          />
          <TagSelector
            ref={tagInputRef}
            value={editTags}
            onChange={e => setEditTags(e.target.value)}
            allTags={allTags}
            placeholder="Tags…"
            onCommit={commitEdits}
          />

          {!isDone && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingTop: '4px' }}>
              <button
                onClick={() => setShowReschedule(s => !s)}
                style={{
                  fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
                  background: 'rgba(107,163,214,0.1)', color: 'var(--accent)',
                  border: '1px solid rgba(107,163,214,0.25)', cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                }}
              >
                Reschedule
              </button>
            </div>
          )}

          {showReschedule && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="date"
                  value={scheduleDate}
                  min={today()}
                  onChange={e => setScheduleDate(e.target.value)}
                  style={{
                    flex: 1, fontSize: '12px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-mid)',
                    borderRadius: '8px', padding: '6px 10px',
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-body)',
                    outline: 'none',
                  }}
                />
                <button
                  onClick={handleSchedule}
                  style={{
                    fontSize: '12px', padding: '6px 12px', borderRadius: '8px',
                    background: 'rgba(107,163,214,0.15)', color: 'var(--accent)',
                    border: '1px solid rgba(107,163,214,0.3)', cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  Set date
                </button>
              </div>
              <button
                onClick={() => { moveToBacklog(task.id); setShowReschedule(false) }}
                style={{
                  fontSize: '12px', padding: '4px 10px', borderRadius: '8px',
                  background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-light)', cursor: 'pointer',
                  fontFamily: 'var(--font-body)', textAlign: 'left',
                }}
              >
                Move to backlog
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
