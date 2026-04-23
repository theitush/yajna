import { useEffect, useMemo, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { getAllJournals } from '../services/db'
import useAppStore from '../store/useAppStore'
import { formatDate, today } from '../lib/dates'
import { buildReviewDays } from '../lib/review'
import { RTLExtension } from '../components/editor/RTLExtension'
import { AudioNode } from '../components/editor/AudioNode'
import { BlockIdExtension } from '../components/editor/BlockIdExtension'
import { HeadingNoShortcut } from '../components/editor/HeadingNoShortcut'

function CollapsedCommentPreview({ comment }) {
  if (!comment) return null
  return (
    <div style={collapsedCommentStyle}>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
        {comment.text}
      </div>
      <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-tertiary)' }}>
        {comment.updatedAt ? 'Edited' : 'Saved'} {new Date(comment.updatedAt || comment.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </div>
    </div>
  )
}

function SingleCommentEditor({ comment, placeholder, onSave }) {
  const [draft, setDraft] = useState(comment?.text || '')

  useEffect(() => {
    setDraft(comment?.text || '')
  }, [comment?.text])

  const handleSubmit = () => {
    if (!draft.trim()) return
    onSave(draft.trim())
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {comment && (
        <div style={commentBubbleStyle}>
          <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginBottom: '6px' }}>
            {comment.updatedAt ? 'Edited' : 'Saved'} {new Date(comment.updatedAt || comment.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>
      )}

      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            handleSubmit()
          }
        }}
        rows={3}
        placeholder={placeholder}
        style={commentInputStyle}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={handleSubmit} style={commentButtonStyle}>
          {comment ? 'Save comment' : 'Add comment'}
        </button>
      </div>
    </div>
  )
}

function IconButton({ active = false, onClick, title, children }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} style={iconButtonStyle(active)}>
      {active ? children : null}
    </button>
  )
}

function CommentEditButton({ hasComment, onClick }) {
  const label = hasComment ? 'Edit comment' : 'Add comment'
  return (
    <button onClick={onClick} title={label} aria-label={label} style={commentEditButtonStyle}>
      <PencilIcon />
    </button>
  )
}

function JournalBlock({ block, comments, onAddComment }) {
  const [hovered, setHovered] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const singleComment = comments?.[0] || null
  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      RTLExtension,
      AudioNode.configure({ readOnly: true }),
      BlockIdExtension,
    ],
    content: block.html || '',
  })

  useEffect(() => {
    if (!editor) return
    if (editor.getHTML() !== (block.html || '')) {
      editor.commands.setContent(block.html || '', { emitUpdate: false })
    }
  }, [editor, block.html])

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        padding: '10px 0 14px',
        borderBottom: commentsOpen ? '1px solid var(--border-light)' : '1px solid transparent',
      }}
    >
      <div style={{ position: 'absolute', top: '8px', right: 0, opacity: hovered || commentsOpen ? 1 : 0, transition: 'opacity 0.15s' }}>
        <CommentEditButton hasComment={Boolean(singleComment)} onClick={() => setCommentsOpen(true)} />
      </div>

      <div style={{ paddingRight: '96px' }}>
        <EditorContent editor={editor} />
      </div>

      {!commentsOpen && singleComment && (
        <div style={{ marginTop: '10px', paddingRight: '96px' }}>
          <CollapsedCommentPreview comment={singleComment} />
        </div>
      )}

      {commentsOpen && (
        <div style={{ marginTop: '12px', paddingRight: '12px' }}>
          <SingleCommentEditor
            comment={singleComment}
            placeholder="Comment on this paragraph..."
            onSave={(text) => {
              onAddComment(text)
              setCommentsOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}

function ReviewJournalPane({ day, onToggleReview, onAddBlockComment }) {
  const blocks = (day.journalEntry?.blocks || []).filter(block => !block.deleted)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <span style={paneLabelStyle}>Journal</span>
        <IconButton active={day.journalReviewed} onClick={onToggleReview} title={day.journalReviewed ? 'Unreview journal' : 'Review journal'}>
          <CheckIcon />
        </IconButton>
      </div>

      <div
        className="review-scroll"
        style={{
          ...scrollPaneStyle,
          ...reviewSurfaceStyle(day.journalReviewed),
          margin: '2px 2px 4px',
          padding: '18px 24px 32px',
        }}
      >
        {blocks.length === 0 ? (
          <div style={emptyStateStyle}>
            No journal entry for this day.
          </div>
        ) : (
          blocks.map(block => (
            <JournalBlock
              key={block.id}
              block={block}
              comments={day.journalEntry?.blockComments?.[block.id] || []}
              onAddComment={text => onAddBlockComment(block.id, text)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ReviewTaskCard({ task, onToggleReview, onAddComment }) {
  const [commentsOpen, setCommentsOpen] = useState(false)
  const singleComment = task.comments?.[task.comments.length - 1] || null

  const tone = task.completed
    ? (task.reviewed ? 'completedReviewed' : 'completed')
    : (task.reviewed ? 'reviewed' : 'default')

  return (
    <article style={taskCardStyle(tone)}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0, paddingTop: '2px' }}>
          <IconButton active={task.reviewed} onClick={onToggleReview} title={task.reviewed ? 'Unreview task' : 'Review task'}>
            <CheckIcon />
          </IconButton>
          <CommentEditButton hasComment={Boolean(singleComment)} onClick={() => setCommentsOpen(true)} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <h3 style={taskTitleStyle(tone)}>{task.title?.trim() || 'Untitled'}</h3>
          </div>

          {(task.explanation || task.feedback || task.tags) && (
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {task.explanation && <p dir="auto" style={taskTextStyle}>{task.explanation}</p>}
              {task.feedback && <p dir="auto" style={{ ...taskTextStyle, color: 'var(--text-tertiary)' }}>{task.feedback}</p>}
              {task.tags && <p dir="auto" style={{ ...taskTextStyle, color: 'var(--accent)' }}>{task.tags}</p>}
            </div>
          )}

          {!commentsOpen && singleComment && (
            <div style={{ marginTop: '12px' }}>
              <CollapsedCommentPreview comment={singleComment} />
            </div>
          )}

          {commentsOpen && (
            <div style={{ marginTop: '14px' }}>
              <SingleCommentEditor
                comment={singleComment}
                placeholder="Comment on this task..."
                onSave={(text) => {
                  onAddComment(text)
                  setCommentsOpen(false)
                }}
              />
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function TasksReviewPane({ day, onToggleTask, onAddTaskComment }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={paneLabelStyle}>Tasks</span>
          <span style={headerCountStyle}>{day.tasks.length}</span>
        </div>
      </div>

      <div className="review-scroll" style={{ ...scrollPaneStyle, padding: '18px 16px 22px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {day.tasks.length === 0 ? (
          <div style={emptyStateStyle}>No tasks were active or completed on this day.</div>
        ) : (
          day.tasks.map(task => (
            <ReviewTaskCard
              key={`${day.date}-${task.id}`}
              task={task}
              onToggleReview={() => onToggleTask(task)}
              onAddComment={text => onAddTaskComment(task.id, text)}
            />
          ))
        )}
      </div>
    </div>
  )
}

export default function ReviewPage() {
  const tasks = useAppStore(s => s.tasks)
  const reviewVersion = useAppStore(s => s.reviewVersion)
  const setTaskReviewedForDate = useAppStore(s => s.setTaskReviewedForDate)
  const addTaskReviewComment = useAppStore(s => s.addTaskReviewComment)
  const setJournalEntryReviewed = useAppStore(s => s.setJournalEntryReviewed)
  const addJournalBlockComment = useAppStore(s => s.addJournalBlockComment)
  const [journalDocs, setJournalDocs] = useState([])
  const [selectedDate, setSelectedDate] = useState(null)
  const todayStr = today()

  useEffect(() => {
    let active = true
    getAllJournals().then(docs => {
      if (active) setJournalDocs(docs || [])
    }).catch(() => {
      if (active) setJournalDocs([])
    })
    return () => {
      active = false
    }
  }, [reviewVersion])

  const reviewDays = useMemo(
    () => buildReviewDays({ tasks, journalDocs, todayStr }),
    [tasks, journalDocs, todayStr]
  )

  const pendingDaysCount = reviewDays.filter(day => day.needsReview).length
  const selectedDay = reviewDays.find(day => day.date === selectedDate) || reviewDays[0] || null

  useEffect(() => {
    if (!selectedDay && reviewDays[0]) {
      setSelectedDate(reviewDays[0].date)
      return
    }
    if (selectedDate && !reviewDays.some(day => day.date === selectedDate)) {
      setSelectedDate(reviewDays[0]?.date || null)
    }
  }, [reviewDays, selectedDate, selectedDay])

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg-primary)' }}>
      <style>{`
        .review-scroll {
          scrollbar-gutter: stable;
        }
        .review-scroll::-webkit-scrollbar {
          width: 10px;
        }
        .review-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .review-scroll::-webkit-scrollbar-thumb {
          background: rgba(148, 163, 184, 0.38);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .review-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(148, 163, 184, 0.58);
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
      <aside className="hidden md:flex" style={sidebarStyle}>
        <div style={sidebarHeaderStyle}>
          <div>
            <div style={eyebrowStyle}>Review</div>
            <h1 style={{ margin: '6px 0 0', fontSize: '20px', fontWeight: 500, color: 'var(--text-primary)' }}>
              {pendingDaysCount > 0 ? `Review (${pendingDaysCount})` : 'Review'}
            </h1>
          </div>
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            Past days with journal or task activity, without future dates.
          </p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 18px' }}>
          {reviewDays.map(day => (
            <button
              key={day.date}
              onClick={() => setSelectedDate(day.date)}
              style={sidebarDateButtonStyle(day.date === selectedDay?.date, day.needsReview)}
            >
              <div style={{ minWidth: 0 }}>
                <div style={sidebarDateTitleStyle()}>
                  {new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </div>
              </div>
            </button>
          ))}

          {reviewDays.length === 0 && (
            <div style={{ padding: '20px 12px', fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
              No past journal or task data yet.
            </div>
          )}
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {selectedDay ? (
          <>
            <div className="md:hidden" style={{ padding: '12px 16px 0', borderBottom: '1px solid var(--border-light)' }}>
              <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '12px' }}>
                {reviewDays.map(day => (
                  <button
                    key={`mobile-${day.date}`}
                    onClick={() => setSelectedDate(day.date)}
                    style={{
                      border: 'none',
                      borderRadius: '999px',
                      padding: '8px 12px',
                      whiteSpace: 'nowrap',
                      background: day.needsReview ? 'transparent' : 'rgba(16,185,129,0.05)',
                      color: day.date === selectedDay?.date ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: '12px',
                      fontWeight: 500,
                      boxShadow: day.date === selectedDay?.date ? 'inset 0 0 0 1px rgba(148,163,184,0.24)' : 'inset 0 0 0 1px var(--border-light)',
                    }}
                  >
                    {new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {day.needsReview ? ` / ${day.pendingTaskReviews + (day.hasJournal && !day.journalReviewed ? 1 : 0)}` : ''}
                  </button>
                ))}
              </div>
            </div>

            <header style={pageHeaderStyle}>
              <div>
                <div style={eyebrowStyle}>Selected day</div>
                <h2 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 500, color: 'var(--text-primary)' }}>
                  {formatDate(selectedDay.date)}
                </h2>
              </div>
            </header>

            <div className="hidden md:flex" style={{ flex: 1, minHeight: 0 }}>
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-light)' }}>
                <ReviewJournalPane
                  day={selectedDay}
                  onToggleReview={() => setJournalEntryReviewed(selectedDay.date, !selectedDay.journalReviewed)}
                  onAddBlockComment={(blockId, text) => addJournalBlockComment(selectedDay.date, blockId, text)}
                />
              </div>
              <div style={{ width: '360px', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <TasksReviewPane
                  day={selectedDay}
                  onToggleTask={task => setTaskReviewedForDate(task.id, selectedDay.date, !task.reviewed)}
                  onAddTaskComment={(taskId, text) => addTaskReviewComment(taskId, selectedDay.date, text)}
                />
              </div>
            </div>

            <div className="md:hidden review-scroll" style={{ ...scrollPaneStyle, padding: 0 }}>
              <div style={{ borderBottom: '1px solid var(--border-light)' }}>
                <ReviewJournalPane
                  day={selectedDay}
                  onToggleReview={() => setJournalEntryReviewed(selectedDay.date, !selectedDay.journalReviewed)}
                  onAddBlockComment={(blockId, text) => addJournalBlockComment(selectedDay.date, blockId, text)}
                />
              </div>
              <div>
                <TasksReviewPane
                  day={selectedDay}
                  onToggleTask={task => setTaskReviewedForDate(task.id, selectedDay.date, !task.reviewed)}
                  onAddTaskComment={(taskId, text) => addTaskReviewComment(taskId, selectedDay.date, text)}
                />
              </div>
            </div>
          </>
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
            <div style={{ textAlign: 'center', maxWidth: '24rem', padding: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 500, color: 'var(--text-primary)' }}>Nothing to review yet</h2>
              <p style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                As soon as you have journal entries or tasks across the days, they'll show up here.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

const sidebarStyle = {
  width: '250px',
  flexShrink: 0,
  borderRight: '1px solid var(--border-light)',
  display: 'flex',
  flexDirection: 'column',
}

const sidebarHeaderStyle = {
  padding: '20px 18px 14px',
  borderBottom: '1px solid var(--border-light)',
}

const pageHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '18px 22px',
  borderBottom: '1px solid var(--border-light)',
}

const paneHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border-light)',
}

const paneLabelStyle = {
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text-primary)',
}

const headerCountStyle = {
  fontSize: '12px',
  color: 'var(--text-tertiary)',
  background: 'var(--bg-secondary)',
  padding: '1px 8px',
  borderRadius: '20px',
}

const eyebrowStyle = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.9px',
  color: 'var(--text-tertiary)',
  fontWeight: 500,
}

const emptyStateStyle = {
  padding: '18px 0',
  fontSize: '13px',
  color: 'var(--text-tertiary)',
}

function sidebarDateButtonStyle(selected, needsReview) {
  return {
    width: '100%',
    border: 'none',
    borderRadius: '16px',
    padding: '12px 12px',
    marginBottom: '8px',
    background: needsReview ? 'transparent' : 'rgba(16,185,129,0.05)',
    boxShadow: selected ? 'inset 0 0 0 1px rgba(148,163,184,0.24)' : 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: '12px',
    textAlign: 'left',
    cursor: 'pointer',
  }
}

function sidebarDateTitleStyle() {
  return {
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--text-primary)',
  }
}

function iconButtonStyle(active) {
  return {
    width: 22,
    height: 22,
    borderRadius: '50%',
    border: active ? 'none' : '2px solid var(--border-mid)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: 'white',
    background: active ? 'var(--green-500)' : 'transparent',
    boxShadow: active ? '0 0 0 3px rgba(16,185,129,0.2), 0 2px 12px rgba(16,185,129,0.35)' : 'none',
    transition: 'all 0.2s',
    flexShrink: 0,
  }
}

const commentEditButtonStyle = {
  border: 'none',
  display: 'grid',
  placeItems: 'center',
  width: '18px',
  height: '18px',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--text-secondary)',
  background: 'transparent',
  boxShadow: 'none',
  fontFamily: 'var(--font-body)',
  transition: 'color 0.15s ease',
  flexShrink: 0,
}

function taskCardStyle(tone) {
  const palette = {
    default: {
      border: '1px solid var(--border-light)',
      background: 'var(--bg-primary)',
    },
    reviewed: {
      border: '1px solid rgba(34,197,94,0.34)',
      background: 'var(--bg-primary)',
    },
    completed: {
      border: '1px solid rgba(16,185,129,0.24)',
      background: 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(16,185,129,0.05))',
    },
    completedReviewed: {
      border: '1px solid rgba(34,197,94,0.36)',
      background: 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(16,185,129,0.05))',
    },
  }[tone]

  return {
    borderRadius: '10px',
    padding: '14px',
    border: palette.border,
    background: palette.background,
  }
}

function taskTitleStyle(tone) {
  return {
    margin: 0,
    fontSize: '14px',
    fontWeight: 500,
    color: 'var(--text-primary)',
    textDecoration: tone === 'completed' || tone === 'completedReviewed' ? 'line-through' : 'none',
    lineHeight: 1.4,
  }
}

function reviewSurfaceStyle(reviewed) {
  return {
    borderRadius: '16px',
    border: reviewed ? '1px solid rgba(34,197,94,0.34)' : '1px solid var(--border-light)',
    background: 'var(--bg-primary)',
  }
}

const taskTextStyle = {
  margin: 0,
  fontSize: '12px',
  lineHeight: 1.6,
  color: 'var(--text-secondary)',
  whiteSpace: 'pre-wrap',
}

const commentBubbleStyle = {
  borderRadius: '12px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid var(--border-light)',
  padding: '10px 12px',
}

const collapsedCommentStyle = {
  borderRadius: '12px',
  background: 'rgba(255,255,255,0.025)',
  border: '1px solid var(--border-light)',
  padding: '10px 12px',
}

const commentInputStyle = {
  width: '100%',
  resize: 'vertical',
  minHeight: '64px',
  borderRadius: '12px',
  border: '1px solid var(--border-light)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  padding: '10px 12px',
  fontSize: '12px',
  fontFamily: 'var(--font-body)',
  outline: 'none',
}

const commentButtonStyle = {
  border: 'none',
  borderRadius: '999px',
  padding: '8px 12px',
  cursor: 'pointer',
  background: 'var(--accent-light)',
  color: 'var(--accent)',
  fontSize: '12px',
  fontWeight: 500,
  fontFamily: 'var(--font-body)',
}

const scrollPaneStyle = {
  flex: 1,
  overflowY: 'scroll',
  overflowX: 'hidden',
  minHeight: 0,
  scrollbarWidth: 'thin',
  scrollbarColor: 'var(--border-mid) transparent',
  overscrollBehavior: 'contain',
}
