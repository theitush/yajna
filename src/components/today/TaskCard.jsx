import { useState, useRef, useEffect, useCallback } from 'react'
import useAppStore from '../../store/useAppStore'
import { today } from '../../lib/dates'

export default function TaskCard({ task }) {
  const { markTaskDone, markTaskActive, markTaskReviewed, deleteTask, moveToBacklog, scheduleTask, updateTask } = useAppStore()
  const [showReschedule, setShowReschedule] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [editExplanation, setEditExplanation] = useState(task.explanation || '')
  const [editFeedback, setEditFeedback] = useState(task.feedback || '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const cardRef = useRef(null)
  const titleRef = useRef(null)

  const isDone = task.status === 'done'

  useEffect(() => {
    setEditExplanation(task.explanation || '')
    setEditFeedback(task.feedback || '')
  }, [task.explanation, task.feedback])

  // Collapse + save when clicking outside
  const handleClickOutside = useCallback((e) => {
    if (cardRef.current && !cardRef.current.contains(e.target)) {
      updateTask(task.id, {
        explanation: editExplanation.trim(),
        feedback: editFeedback.trim(),
      })
      setExpanded(false)
      setShowReschedule(false)
      setConfirmDelete(false)
    }
  }, [editExplanation, editFeedback, task.id, updateTask])

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

  const handleCheckmark = () => {
    if (isDone) markTaskActive(task.id)
    else markTaskDone(task.id)
  }

  const handleTitleBlur = () => {
    const val = titleRef.current?.innerText.trim()
    if (val && val !== task.title) {
      updateTask(task.id, { title: val })
    }
  }

  const handleTitleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      titleRef.current?.blur()
    }
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
    setTimeout(() => {
      if (titleRef.current) {
        titleRef.current.focus()
        const range = document.createRange()
        const sel = window.getSelection()
        range.selectNodeContents(titleRef.current)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }, 0)
  }

  return (
    <div
      ref={cardRef}
      className={`rounded-xl border shadow-sm transition-colors ${
        isDone ? 'bg-emerald-950/40 border-emerald-800/50' : 'bg-zinc-800 border-zinc-700'
      }`}
    >
      {/* Header row */}
      <div className="flex items-start gap-3 p-4 pb-2">
        <button
          onClick={handleCheckmark}
          className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${
            isDone ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-500 hover:border-emerald-400'
          }`}
          aria-label={isDone ? 'Mark as active' : 'Mark as done'}
        >
          {isDone && (
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>

        <span
          ref={titleRef}
          contentEditable
          suppressContentEditableWarning
          onFocus={() => setExpanded(true)}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKey}
          className={`text-sm font-medium flex-1 leading-snug outline-none cursor-text ${
            isDone ? 'text-emerald-200 line-through decoration-emerald-600' : 'text-zinc-100'
          }`}
        >
          {task.title}
        </span>

        {/* X button — always visible */}
        {task.status !== 'dismissed' && task.status !== 'reviewed' && (
          <button
            onClick={handleX}
            className="flex-shrink-0 text-zinc-600 hover:text-red-400 transition-colors mt-0.5"
            aria-label={isDone ? 'Mark as reviewed' : 'Delete task'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}

        {/* Status badges — when collapsed */}
        {!expanded && task.status === 'scheduled' && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0 bg-amber-900/50 text-amber-300 border border-amber-700/50">
            {task.scheduledDate}
          </span>
        )}
        {!expanded && task.status === 'backlog' && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0 bg-zinc-700 text-zinc-400 border border-zinc-600">
            backlog
          </span>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="px-4 pb-3 pl-12 flex items-center gap-2">
          <p className="text-xs text-red-400 flex-1">Delete this task?</p>
          <button
            onClick={() => deleteTask(task.id)}
            className="text-xs px-2.5 py-1 rounded-lg bg-red-900/60 text-red-300 hover:bg-red-800/70 border border-red-700/50 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            className="text-xs px-2.5 py-1 rounded-lg bg-zinc-700 text-zinc-400 hover:bg-zinc-600 border border-zinc-600 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Collapsed: explanation + feedback preview */}
      {!expanded && !confirmDelete && (task.explanation || task.feedback) && (
        <button onClick={openExpanded} className="w-full text-left px-4 pb-3 pl-12 space-y-1.5">
          {task.explanation && (
            <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2">{task.explanation}</p>
          )}
          {task.feedback && (
            <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2">
              <span className="font-medium text-zinc-500">Feedback: </span>{task.feedback}
            </p>
          )}
        </button>
      )}

      {/* Expanded: editable fields + actions */}
      {expanded && (
        <div className="px-4 pb-4 pl-12 space-y-2">
          <textarea
            value={editExplanation}
            onChange={e => setEditExplanation(e.target.value)}
            rows={2}
            className="w-full text-xs bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-zinc-300 placeholder-zinc-500 outline-none focus:ring-2 focus:ring-violet-500 resize-none"
            placeholder="Explanation…"
          />

          <div>
            <p className="text-xs text-zinc-500 font-medium mb-1">Feedback</p>
            <textarea
              value={editFeedback}
              onChange={e => setEditFeedback(e.target.value)}
              rows={2}
              className="w-full text-xs bg-zinc-700/60 border border-zinc-600/60 rounded-lg px-3 py-2 text-zinc-300 placeholder-zinc-500 outline-none focus:ring-2 focus:ring-violet-500 resize-none"
              placeholder="Feedback…"
            />
          </div>

          {!isDone && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                onClick={() => setShowReschedule(s => !s)}
                className="text-xs px-2.5 py-1 rounded-lg bg-sky-900/50 text-sky-300 hover:bg-sky-900/70 transition-colors border border-sky-700/50"
              >
                Reschedule
              </button>
            </div>
          )}

          {showReschedule && (
            <div className="space-y-1.5">
              <div className="flex gap-2">
                <input
                  type="date"
                  value={scheduleDate}
                  min={today()}
                  onChange={e => setScheduleDate(e.target.value)}
                  className="text-xs border border-zinc-600 rounded-lg px-2 py-1 flex-1 bg-zinc-700 text-zinc-200"
                />
                <button
                  onClick={handleSchedule}
                  className="text-xs px-3 py-1 bg-sky-600 text-white rounded-lg hover:bg-sky-700"
                >
                  Set date
                </button>
              </div>
              <button
                onClick={() => { moveToBacklog(task.id); setShowReschedule(false) }}
                className="text-xs px-2.5 py-1 rounded-lg bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200 transition-colors border border-zinc-600"
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
