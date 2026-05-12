import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import useHighlightTarget from '../lib/useHighlightTarget'
import StarterKit from '@tiptap/starter-kit'
import { getAllJournals } from '../services/db'
import useAppStore from '../store/useAppStore'
import { formatDate, today } from '../lib/dates'
import { buildReviewDays } from '../lib/review'
import { RTLExtension } from '../components/editor/RTLExtension'
import { AudioNode, PALETTE, rankAudioItems } from '../components/editor/AudioNode'
import { BlockIdExtension } from '../components/editor/BlockIdExtension'
import { HeadingNoShortcut } from '../components/editor/HeadingNoShortcut'
import JournalPanel from '../components/today/JournalPanel'
import TasksPanel from '../components/today/TasksPanel'

const HASHTAG_RE = /(#[\p{L}\p{N}_-]+)/gu

function renderWithHashtags(text) {
  if (!text) return text
  const parts = String(text).split(HASHTAG_RE)
  return parts.map((part, i) =>
    part.startsWith('#')
      ? <span key={i} style={{ color: 'var(--accent)', fontWeight: 500 }}>{part}</span>
      : part
  )
}

function CollapsedCommentPreview({ comment, onClick }) {
  if (!comment) return null
  return (
    <div onClick={onClick} style={collapsedCommentStyle}>
      <div dir="auto" style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', textAlign: 'start' }}>
        {comment.text}
      </div>
      <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-tertiary)' }}>
        {comment.updatedAt ? 'Edited' : 'Saved'} {new Date(comment.updatedAt || comment.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </div>
    </div>
  )
}

function SingleCommentEditor({ comment, placeholder, onSave, onClose }) {
  const [draft, setDraft] = useState(comment?.text || '')

  const handleCommit = () => {
    const text = draft.trim()
    if (text) onSave(text)
    else onClose()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea
        dir="auto"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            handleCommit()
          }
        }}
        onBlur={handleCommit}
        rows={3}
        placeholder={placeholder}
        style={commentInputStyle}
        autoFocus
      />
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

function JournalBlock({ block, comments, commentsOpen, onOpenComment, onCloseComment, onAddComment, audioRanks, highlighted, highlightRef }) {
  const [hovered, setHovered] = useState(false)
  const singleComment = comments?.[0] || null
  const isRtl = block.html?.includes('dir="rtl"')

  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, listItem: false, taskList: false, taskItem: false }),
      HeadingNoShortcut,
      RTLExtension,
      AudioNode.configure({
        readOnly: true,
        getRank: (audioId) => audioRanks?.get(audioId) ?? null,
      }),
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
      ref={highlighted ? highlightRef : null}
      className={highlighted ? 'search-highlight' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        padding: '2px 0',
        borderBottom: commentsOpen ? '1px solid var(--border-light)' : '1px solid transparent',
      }}
    >
      <div style={{
        position: 'absolute',
        top: '2px',
        [isRtl ? 'left' : 'right']: 0,
        opacity: hovered || commentsOpen ? 1 : 0,
        transition: 'opacity 0.15s'
      }}>
        <CommentEditButton hasComment={Boolean(singleComment)} onClick={onOpenComment} />
      </div>

      <div
        onClick={onOpenComment}
        style={{
          paddingRight: !isRtl ? '24px' : '0',
          paddingLeft: isRtl ? '24px' : '0',
          cursor: 'pointer',
          borderRadius: '8px',
          textAlign: 'start',
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {!commentsOpen && singleComment && (
        <div style={{
          marginTop: '6px',
          paddingRight: isRtl ? '0' : '24px',
          paddingLeft: isRtl ? '24px' : '0'
        }}>
          <CollapsedCommentPreview comment={singleComment} onClick={onOpenComment} />
        </div>
      )}

      {commentsOpen && (
        <div style={{
          marginTop: '8px',
          paddingRight: isRtl ? '0' : '12px',
          paddingLeft: isRtl ? '12px' : '0'
        }}>
          <SingleCommentEditor
            key={singleComment?.updatedAt || singleComment?.createdAt || 'new-comment'}
            comment={singleComment}
            placeholder="Comment on this paragraph..."
            onSave={(text) => {
              onAddComment(text)
              onCloseComment()
            }}
            onClose={onCloseComment}
          />
        </div>
      )}
    </div>
  )
}

function ReviewJournalPane({ day, title = 'Journal', openCommentKey, onOpenComment, onCloseComment, onToggleReview, onAddBlockComment, highlightBlockId, highlightRef }) {
  const blocks = (day.journalEntry?.blocks || []).filter(block => !block.deleted)

  // Each JournalBlock renders into its own editor, so rankInDoc would only
  // see one audio at a time. Collect every audio across the day's blocks here
  // and feed them to the shared ranker so tints stay consistent with journal/edit.
  const audioRanks = (() => {
    const items = []
    let docIdx = 0
    const tagRe = /<div\b[^>]*data-audio-id="[^"]+[^>]*>/g
    const idRe = /data-audio-id="([^"]+)"/
    const createdRe = /data-created-at="([^"]*)"/
    blocks.forEach(b => {
      const html = b.html || ''
      let m
      while ((m = tagRe.exec(html)) !== null) {
        const id = idRe.exec(m[0])?.[1]
        const createdAt = createdRe.exec(m[0])?.[1] || null
        if (id) items.push({ id, createdAt, docIdx: docIdx++ })
      }
    })
    return rankAudioItems(items)
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <span style={paneLabelStyle}>{title}</span>
        <IconButton active={day.journalReviewed} onClick={onToggleReview} title={day.journalReviewed ? 'Unreview journal' : 'Review journal'}>
          <CheckIcon />
        </IconButton>
      </div>

      <div
        className="review-scroll"
        style={{
          ...scrollPaneStyle,
          ...reviewSurfaceStyle(day.journalReviewed),
          margin: 0,
          padding: '10px 12px 14px',
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
              audioRanks={audioRanks}
              comments={day.journalEntry?.blockComments?.[block.id] || []}
              commentsOpen={openCommentKey === `journal:${day.date}:${block.id}`}
              onOpenComment={() => onOpenComment(`journal:${day.date}:${block.id}`)}
              onCloseComment={onCloseComment}
              onAddComment={text => onAddBlockComment(block.id, text)}
              highlighted={block.id === highlightBlockId}
              highlightRef={block.id === highlightBlockId ? highlightRef : null}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ReviewTaskCard({ task, commentsOpen, onOpenComment, onCloseComment, onToggleReview, onAddComment }) {
  const singleComment = task.comments?.[task.comments.length - 1] || null
  const isCompleted = task.completed
  const tone = isCompleted
    ? (task.reviewed ? 'completedReviewed' : 'completed')
    : (task.reviewed ? 'reviewed' : 'default')

  const createdDate = task.createdDate || task.createdAt?.slice(0, 10)
  const doneDate = task.doneDate || null
  const daysDiff = (createdDate && doneDate && createdDate !== doneDate)
    ? Math.round((new Date(`${doneDate}T12:00:00`) - new Date(`${createdDate}T12:00:00`)) / (1000 * 60 * 60 * 24))
    : null

  return (
    <article style={taskCardStyle(tone)}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0, paddingTop: '2px' }}>
          <IconButton active={task.reviewed} onClick={onToggleReview} title={task.reviewed ? 'Unreview task' : 'Review task'}>
            <CheckIcon />
          </IconButton>
          <CommentEditButton hasComment={Boolean(singleComment)} onClick={onOpenComment} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div onClick={onOpenComment} style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <h3 dir="auto" style={taskTitleStyle(tone)}>{task.title?.trim() || 'Untitled'}</h3>
              {daysDiff !== null && (
                <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 400 }}>
                  {daysDiff} day{daysDiff !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {(task.explanation || task.feedback || task.tags) && (
              <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {task.explanation && <p dir="auto" style={taskTextStyle}>{renderWithHashtags(task.explanation)}</p>}
                {task.feedback && <p dir="auto" style={{ ...taskTextStyle, color: 'var(--text-tertiary)' }}>{renderWithHashtags(task.feedback)}</p>}
                {task.tags && <p dir="auto" style={{ ...taskTextStyle, color: 'var(--text-tertiary)' }}>{renderWithHashtags(task.tags)}</p>}
              </div>
            )}
          </div>

          {!commentsOpen && singleComment && (
            <div style={{ marginTop: '12px' }}>
              <CollapsedCommentPreview comment={singleComment} onClick={onOpenComment} />
            </div>
          )}

          {commentsOpen && (
            <div style={{ marginTop: '14px' }}>
              <SingleCommentEditor
                key={singleComment?.updatedAt || singleComment?.createdAt || 'new-comment'}
                comment={singleComment}
                placeholder="Comment on this task..."
                onSave={(text) => {
                  onAddComment(text)
                  onCloseComment()
                }}
                onClose={onCloseComment}
              />
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function TasksReviewPane({ day, openCommentKey, onOpenComment, onCloseComment, onToggleTask, onAddTaskComment }) {
  const completedTasks = day.tasks.filter(task => task.completed)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={paneLabelStyle}>Tasks</span>
          <span style={headerCountStyle}>{completedTasks.length}</span>
        </div>
      </div>

      <div className="review-scroll" style={{ ...scrollPaneStyle, padding: '10px 12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {completedTasks.length === 0 ? (
          <div style={emptyStateStyle}>No completed tasks to review.</div>
        ) : (
          completedTasks.map(task => (
            <ReviewTaskCard
              key={`${day.date}-${task.id}`}
              task={task}
              commentsOpen={openCommentKey === `task:${day.date}:${task.id}`}
              onOpenComment={() => onOpenComment(`task:${day.date}:${task.id}`)}
              onCloseComment={onCloseComment}
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
  const reviews = useAppStore(s => s.reviews)
  const reviewVersion = useAppStore(s => s.reviewVersion)
  const setTaskReviewedForDate = useAppStore(s => s.setTaskReviewedForDate)
  const addTaskReviewComment = useAppStore(s => s.addTaskReviewComment)
  const setJournalEntryReviewed = useAppStore(s => s.setJournalEntryReviewed)
  const addJournalBlockComment = useAppStore(s => s.addJournalBlockComment)
  const syncAllJournals = useAppStore(s => s.syncAllJournals)
  const [searchParams] = useSearchParams()
  const urlDate = searchParams.get('date')
  const highlightBlock = useHighlightTarget('block')
  const highlightRef = useRef(null)
  const [journalDocs, setJournalDocs] = useState([])
  const [selectedDate, setSelectedDate] = useState(urlDate || null)
  const [mobileView, setMobileView] = useState(urlDate ? 'detail' : 'list')
  const [mobilePanel, setMobilePanel] = useState('journal')
  const [openCommentKey, setOpenCommentKey] = useState(null)
  const [mode, setMode] = useState('review') // 'review' | 'edit'
  const todayStr = today()

  // If the URL changes (arriving from search), follow it.
  useEffect(() => {
    if (urlDate && urlDate !== selectedDate) {
      setSelectedDate(urlDate)
      setMobileView('detail')
      setMobilePanel('journal')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDate])

  // After the selected day's blocks render, scroll the highlighted block
  // into view. The marker is applied via the `search-highlight` className
  // on the JournalBlock; useHighlightTarget clears the URL on next click.
  useEffect(() => {
    if (!highlightBlock) return
    const t = setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
    return () => clearTimeout(t)
  }, [highlightBlock, selectedDate])

  useEffect(() => {
    syncAllJournals().catch(console.error)
  }, [syncAllJournals])

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
    () => buildReviewDays({ tasks, journalDocs, reviews, todayStr }),
    [tasks, journalDocs, reviews, todayStr]
  )

  const pendingDaysCount = reviewDays.filter(day => day.needsReview).length
  const selectedDay = reviewDays.find(day => day.date === selectedDate) || reviewDays[0] || null

  const handleSelectDate = (date) => {
    setSelectedDate(date)
    setMobilePanel('journal')
    setOpenCommentKey(null)
    setMobileView('detail')
  }

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

      <div
        className={mobileView !== 'list' ? 'hidden md:hidden' : 'flex md:hidden'}
        style={{
          width: '100%',
          flexDirection: 'column',
          background: 'var(--bg-primary)',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderBottom: '1px solid var(--border-light)',
        }}>
          <span style={{ fontSize: '10px', fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Review
          </span>
          {pendingDaysCount > 0 && (
            <span style={{
              fontSize: '12px',
              color: 'var(--text-tertiary)',
              background: 'var(--bg-secondary)',
              padding: '1px 8px',
              borderRadius: '20px',
            }}>
              {pendingDaysCount}
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {reviewDays.map(day => (
            <button
              key={`mobile-list-${day.date}`}
              onClick={() => handleSelectDate(day.date)}
              style={mobileDateButtonStyle(day.date === selectedDay?.date, day.needsReview)}
            >
              <div style={{ minWidth: 0 }}>
                <p style={mobileDateTitleStyle}>{formatDate(day.date)}</p>
              </div>
            </button>
          ))}

          {reviewDays.length === 0 && (
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '12px', lineHeight: 1.6 }}>
              No past journal or task data yet.
            </p>
          )}
        </div>
      </div>

      <main
        className={mobileView !== 'detail' ? 'hidden md:flex' : ''}
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: 'column',
          display: mobileView === 'detail' ? 'flex' : undefined,
        }}
      >
        {selectedDay ? (
          <>
            <div className="flex md:hidden" style={{ ...mobileDetailHeaderStyle, justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button
                  onClick={() => setMobileView('list')}
                  style={mobileBackButtonStyle}
                >
                  &larr; Back
                </button>
                <span style={mobileDetailTitleStyle}>{formatDate(selectedDay.date)}</span>
              </div>
              <ModeToggle mode={mode} onChange={setMode} />
            </div>

            <div className="flex md:hidden" style={{ borderBottom: '1px solid var(--border-light)' }}>
              <button
                onClick={() => setMobilePanel('journal')}
                style={mobileTabStyle(mobilePanel === 'journal')}
              >
                Journal
              </button>
              <button
                onClick={() => setMobilePanel('tasks')}
                style={mobileTabStyle(mobilePanel === 'tasks')}
              >
                Tasks
              </button>
            </div>

            <header className="hidden md:flex" style={{ ...pageHeaderStyle, display: undefined }}>
              <div>
                <div style={eyebrowStyle}>Selected day</div>
                <h2 style={{ margin: '4px 0 0', fontSize: '22px', fontWeight: 500, color: 'var(--text-primary)' }}>
                  {formatDate(selectedDay.date)}
                </h2>
              </div>
              <ModeToggle mode={mode} onChange={setMode} />
            </header>

            <div className="hidden md:flex" style={{ flex: 1, minHeight: 0 }}>
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-light)' }}>
                {mode === 'edit' ? (
                  <JournalPanel key={`edit-journal-${selectedDay.date}`} date={selectedDay.date} headerLabel="Journal" />
                ) : (
                  <ReviewJournalPane
                    day={selectedDay}
                    openCommentKey={openCommentKey}
                    onOpenComment={setOpenCommentKey}
                    onCloseComment={() => setOpenCommentKey(null)}
                    onToggleReview={() => setJournalEntryReviewed(selectedDay.date, !selectedDay.journalReviewed)}
                    onAddBlockComment={(blockId, text) => addJournalBlockComment(selectedDay.date, blockId, text)}
                    highlightBlockId={highlightBlock}
                    highlightRef={highlightRef}
                  />
                )}
              </div>
              <div style={{ width: '360px', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {mode === 'edit' ? (
                  <TasksPanel key={`edit-tasks-${selectedDay.date}`} date={selectedDay.date} />
                ) : (
                  <TasksReviewPane
                    day={selectedDay}
                    openCommentKey={openCommentKey}
                    onOpenComment={setOpenCommentKey}
                    onCloseComment={() => setOpenCommentKey(null)}
                    onToggleTask={task => setTaskReviewedForDate(task.id, selectedDay.date, !task.reviewed)}
                    onAddTaskComment={(taskId, text) => addTaskReviewComment(taskId, selectedDay.date, text)}
                  />
                )}
              </div>
            </div>

            <div className="md:hidden" style={{ flex: 1, overflow: 'hidden' }}>
              {mobilePanel === 'journal' ? (
                mode === 'edit' ? (
                  <JournalPanel key={`edit-journal-m-${selectedDay.date}`} date={selectedDay.date} headerLabel="Journal" />
                ) : (
                  <ReviewJournalPane
                    day={selectedDay}
                    openCommentKey={openCommentKey}
                    onOpenComment={setOpenCommentKey}
                    onCloseComment={() => setOpenCommentKey(null)}
                    onToggleReview={() => setJournalEntryReviewed(selectedDay.date, !selectedDay.journalReviewed)}
                    onAddBlockComment={(blockId, text) => addJournalBlockComment(selectedDay.date, blockId, text)}
                    highlightBlockId={highlightBlock}
                    highlightRef={highlightRef}
                  />
                )
              ) : (
                mode === 'edit' ? (
                  <TasksPanel key={`edit-tasks-m-${selectedDay.date}`} date={selectedDay.date} />
                ) : (
                  <TasksReviewPane
                    day={selectedDay}
                    openCommentKey={openCommentKey}
                    onOpenComment={setOpenCommentKey}
                    onCloseComment={() => setOpenCommentKey(null)}
                    onToggleTask={task => setTaskReviewedForDate(task.id, selectedDay.date, !task.reviewed)}
                    onAddTaskComment={(taskId, text) => addTaskReviewComment(taskId, selectedDay.date, text)}
                  />
                )
              )}
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
  padding: '10px 12px',
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

function mobileTabStyle(active) {
  return {
    flex: 1,
    padding: '10px 0',
    fontSize: '13px',
    fontWeight: 500,
    fontFamily: 'var(--font-body)',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none',
    cursor: 'pointer',
    transition: 'color 0.15s',
  }
}

function mobileDateButtonStyle(selected, needsReview) {
  return {
    width: '100%',
    textAlign: 'left',
    padding: '12px 12px',
    borderTop: 'none',
    borderRight: 'none',
    borderBottom: '1px solid var(--border-light)',
    borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
    background: needsReview ? (selected ? 'var(--bg-secondary)' : 'transparent') : 'rgba(16,185,129,0.05)',
    cursor: 'pointer',
    transition: 'background 0.15s',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  }
}

const mobileDateTitleStyle = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const mobileDetailHeaderStyle = {
  alignItems: 'center',
  gap: '10px',
  padding: '8px 16px',
  borderBottom: '1px solid var(--border-light)',
}

const mobileBackButtonStyle = {
  padding: 0,
  fontSize: '12px',
  color: 'var(--accent)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'var(--font-body)',
  flexShrink: 0,
}

const mobileDetailTitleStyle = {
  fontSize: '12px',
  fontWeight: 500,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
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

function ModeToggle({ mode, onChange }) {
  // Soft green for the safe view; soft amber for edit (a gentle "you're touching past days" warning).
  const TONES = {
    review: { bg: `rgba(${PALETTE.emerald},0.85)`, shadow: `0 1px 6px rgba(${PALETTE.emerald},0.35)` },
    edit:    { bg: `rgba(${PALETTE.amber},0.9)`,   shadow: `0 1px 6px rgba(${PALETTE.amber},0.4)`   },
  }
  const segmentStyle = (active, tone) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 12px',
    fontSize: '12px',
    fontWeight: 500,
    fontFamily: 'var(--font-body)',
    border: 'none',
    borderRadius: '999px',
    cursor: 'pointer',
    background: active ? tone.bg : 'transparent',
    color: active ? 'white' : 'var(--text-secondary)',
    boxShadow: active ? tone.shadow : 'none',
    transition: 'background 0.15s, color 0.15s, box-shadow 0.15s',
  })
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        gap: '2px',
        padding: '3px',
        borderRadius: '999px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-light)',
      }}
    >
      <button onClick={() => onChange('review')} style={segmentStyle(mode === 'review', TONES.review)}>
        <EyeIcon />Review
      </button>
      <button onClick={() => onChange('edit')} style={segmentStyle(mode === 'edit', TONES.edit)}>
        <PencilIcon />Edit
      </button>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function taskCardStyle(tone, editable = false) {
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
    padding: '10px 12px',
    border: palette.border,
    background: palette.background,
    transition: 'all 0.2s ease',
    boxShadow: editable ? '0 0 0 1px var(--border-light)' : 'none',
  }
}

function taskTitleStyle(tone) {
  const isCompleted = tone === 'completed' || tone === 'completedReviewed'
  return {
    margin: 0,
    fontSize: '14px',
    fontWeight: 500,
    color: isCompleted ? 'var(--green-800)' : 'var(--text-primary)',
    textDecoration: isCompleted ? 'line-through' : 'none',
    lineHeight: 1.4,
    textAlign: 'start',
    width: '100%',
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
  textAlign: 'start',
  width: '100%',
}

const collapsedCommentStyle = {
  borderRadius: '12px',
  background: 'rgba(255,255,255,0.025)',
  border: '1px solid var(--border-light)',
  padding: '10px 12px',
  cursor: 'pointer',
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
  textAlign: 'start',
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
