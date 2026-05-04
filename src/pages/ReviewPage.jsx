import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
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

function JournalBlock({ block, comments, commentsOpen, onOpenComment, onCloseComment, onAddComment, editable = false, onSaveBlock }) {
  const [hovered, setHovered] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const singleComment = comments?.[0] || null
  const isRtl = block.html?.includes('dir="rtl"')

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

  useEffect(() => {
    if (!editor) return
    editor.setEditable(isEditing)
    if (isEditing) {
      editor.commands.focus('end')
    }
  }, [editor, isEditing])

  useEffect(() => {
    if (!editor) return
    const handleBlur = () => {
      if (isEditing) {
        const html = editor.getHTML()
        if (html !== block.html) {
          onSaveBlock(html)
        }
        setIsEditing(false)
      }
    }
    editor.on('blur', handleBlur)
    return () => editor.off('blur', handleBlur)
  }, [editor, isEditing, block.html, onSaveBlock])

  const handleBlockClick = (e) => {
    if (editable) {
      setIsEditing(true)
    } else {
      onOpenComment()
    }
  }

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
      {!editable && (
        <div style={{ 
          position: 'absolute', 
          top: '8px', 
          [isRtl ? 'left' : 'right']: 0, 
          opacity: hovered || commentsOpen ? 1 : 0, 
          transition: 'opacity 0.15s' 
        }}>
          <CommentEditButton hasComment={Boolean(singleComment)} onClick={onOpenComment} />
        </div>
      )}

      <div
        onClick={handleBlockClick}
        style={{
          paddingRight: (!editable && !isRtl) ? '96px' : '0',
          paddingLeft: (!editable && isRtl) ? '96px' : '0',
          cursor: editable ? 'text' : 'pointer',
          borderRadius: '8px',
          textAlign: 'start',
        }}
      >
        <EditorContent editor={editor} />
      </div>

      {!editable && !commentsOpen && singleComment && (
        <div style={{ 
          marginTop: '10px', 
          paddingRight: isRtl ? '0' : '96px',
          paddingLeft: isRtl ? '96px' : '0'
        }}>
          <CollapsedCommentPreview comment={singleComment} onClick={onOpenComment} />
        </div>
      )}

      {commentsOpen && (
        <div style={{ 
          marginTop: '12px', 
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

function ReviewJournalPane({ day, title = 'Journal', openCommentKey, onOpenComment, onCloseComment, onToggleReview, onAddBlockComment, editable = false, onUpdateBlock }) {
  const blocks = (day.journalEntry?.blocks || []).filter(block => !block.deleted)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <span style={paneLabelStyle}>{title}</span>
        {!editable && (
          <IconButton active={day.journalReviewed} onClick={onToggleReview} title={day.journalReviewed ? 'Unreview journal' : 'Review journal'}>
            <CheckIcon />
          </IconButton>
        )}
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
          editable ? (
            <div 
              onClick={() => onUpdateBlock('initial-block', '<p></p>')}
              style={{ ...emptyStateStyle, cursor: 'pointer', fontStyle: 'italic' }}
            >
              Click here to add a journal entry...
            </div>
          ) : (
            <div style={emptyStateStyle}>
              No journal entry for this day.
            </div>
          )
        ) : (
          blocks.map(block => (
            <JournalBlock
              key={block.id}
              block={block}
              comments={day.journalEntry?.blockComments?.[block.id] || []}
              commentsOpen={openCommentKey === `journal:${day.date}:${block.id}`}
              onOpenComment={() => onOpenComment(`journal:${day.date}:${block.id}`)}
              onCloseComment={onCloseComment}
              onAddComment={text => onAddBlockComment(block.id, text)}
              editable={editable}
              onSaveBlock={html => onUpdateBlock(block.id, html)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ReviewTaskCard({ 
  task, 
  commentsOpen, 
  onOpenComment, 
  onCloseComment, 
  onToggleReview, 
  onAddComment, 
  editable = false, 
  onUpdateTask, 
  onToggleCompletion,
  defaultExpanded = false,
  defaultEditingTitle = false
}) {
  const [isEditing, setIsEditing] = useState(defaultExpanded || defaultEditingTitle)
  const [editTitle, setEditTitle] = useState(task.title || '')
  const [editExplanation, setEditExplanation] = useState(task.explanation || '')
  const [editFeedback, setEditFeedback] = useState(task.feedback || '')
  const [editTags, setEditTags] = useState(task.tags || '')
  const cardRef = useRef(null)

  useEffect(() => {
    if (defaultEditingTitle || defaultExpanded) {
      setIsEditing(true)
    } else {
      setIsEditing(false)
    }
  }, [defaultEditingTitle, defaultExpanded, task.id])

  useEffect(() => {
    setEditTitle(task.title || '')
    setEditExplanation(task.explanation || '')
    setEditFeedback(task.feedback || '')
    setEditTags(task.tags || '')
  }, [task])

  const singleComment = task.comments?.[task.comments.length - 1] || null

  const isCompleted = task.completed
  const tone = isCompleted
    ? (task.reviewed ? 'completedReviewed' : 'completed')
    : (task.reviewed ? 'reviewed' : 'default')

  const handleCommit = useCallback(() => {
    if (isEditing) {
      onUpdateTask({
        title: editTitle,
        explanation: editExplanation,
        feedback: editFeedback,
        tags: editTags
      })
      setIsEditing(false)
    }
  }, [isEditing, editTitle, editExplanation, editFeedback, editTags, onUpdateTask])

  useEffect(() => {
    if (!isEditing) return
    const onClick = (e) => {
      if (cardRef.current && !cardRef.current.contains(e.target)) {
        handleCommit()
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [isEditing, handleCommit])

  const handleCardClick = () => {
    if (editable) {
      setIsEditing(true)
    } else {
      onOpenComment()
    }
  }

  return (
    <article ref={cardRef} style={taskCardStyle(tone, editable)}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0, paddingTop: '2px' }}>
          {editable ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleCompletion()
              }}
              style={{
                width: 22, height: 22,
                borderRadius: '50%',
                border: isCompleted ? 'none' : '2px solid var(--border-mid)',
                background: isCompleted ? 'var(--green-500)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white',
                cursor: 'pointer',
                boxShadow: isCompleted ? '0 0 0 3px rgba(16,185,129,0.2), 0 2px 12px rgba(16,185,129,0.35)' : 'none',
                padding: 0,
              }}
              title={isCompleted ? 'Mark as active' : 'Mark as done'}
            >
              {isCompleted && <CheckIcon />}
            </button>
          ) : (
            <>
              <IconButton active={task.reviewed} onClick={onToggleReview} title={task.reviewed ? 'Unreview task' : 'Review task'}>
                <CheckIcon />
              </IconButton>
              <CommentEditButton hasComment={Boolean(singleComment)} onClick={onOpenComment} />
            </>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {isEditing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <input
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleCommit()
                  }
                }}
                placeholder="Title..."
                style={{ ...commentInputStyle, minHeight: 'auto', fontWeight: 500 }}
                autoFocus
              />
              <textarea
                value={editExplanation}
                onChange={e => setEditExplanation(e.target.value)}
                placeholder="Explanation..."
                style={{ ...commentInputStyle, minHeight: '40px' }}
                rows={2}
              />
              <textarea
                value={editFeedback}
                onChange={e => setEditFeedback(e.target.value)}
                placeholder="Feedback..."
                style={{ ...commentInputStyle, minHeight: '40px', opacity: 0.8 }}
                rows={2}
              />
              <input
                value={editTags}
                onChange={e => setEditTags(e.target.value)}
                placeholder="Tags (e.g. #work #personal)..."
                style={{ ...commentInputStyle, minHeight: 'auto' }}
              />
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button
                  onClick={handleCommit}
                  style={{
                    fontSize: '11px', padding: '4px 12px', borderRadius: '6px',
                    background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer'
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => setIsEditing(false)}
                  style={{
                    fontSize: '11px', padding: '4px 12px', borderRadius: '6px',
                    background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
                    border: '1px solid var(--border-light)', cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div onClick={handleCardClick} style={{ cursor: editable ? 'text' : 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <h3 dir="auto" style={taskTitleStyle(tone)}>{task.title?.trim() || 'Untitled'}</h3>
              </div>

              {(task.explanation || task.feedback || task.tags) && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {task.explanation && <p dir="auto" style={taskTextStyle}>{task.explanation}</p>}
                  {task.feedback && <p dir="auto" style={{ ...taskTextStyle, color: 'var(--text-tertiary)' }}>{task.feedback}</p>}
                  {task.tags && <p dir="auto" style={{ ...taskTextStyle, color: 'var(--accent)' }}>{task.tags}</p>}
                </div>
              )}
            </div>
          )}

          {!isEditing && !commentsOpen && singleComment && (
            <div style={{ marginTop: '12px' }}>
              <CollapsedCommentPreview comment={singleComment} onClick={onOpenComment} />
            </div>
          )}

          {!isEditing && commentsOpen && (
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

function TasksReviewPane({ day, openCommentKey, onOpenComment, onCloseComment, onToggleTask, onAddTaskComment, editable = false, onUpdateTask, onToggleCompletion, onAddTask }) {
  const [justAddedId, setJustAddedId] = useState(null)

  useEffect(() => {
    setJustAddedId(null)
  }, [day.date])

  const handleAdd = async () => {
    const task = await onAddTask('')
    if (task) {
      setJustAddedId(task.id)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={paneHeaderStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={paneLabelStyle}>Tasks</span>
          <span style={headerCountStyle}>{day.tasks.length}</span>
        </div>
        {editable && (
          <button
            onClick={handleAdd}
            style={{
              fontSize: '12px', fontWeight: 500,
              color: 'var(--accent)',
              background: 'var(--accent-light)',
              border: 'none', padding: '5px 14px',
              borderRadius: '8px', cursor: 'pointer',
              fontFamily: 'var(--font-body)',
              transition: 'background 0.15s',
            }}
          >
            + Add
          </button>
        )}
      </div>

      <div className="review-scroll" style={{ ...scrollPaneStyle, padding: '18px 16px 22px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {day.tasks.length === 0 ? (
          <div style={emptyStateStyle}>No reviewable tasks were created on this day.</div>
        ) : (
          day.tasks.map(task => (
            <ReviewTaskCard
              key={`${day.date}-${task.id}`}
              task={task}
              commentsOpen={openCommentKey === `task:${day.date}:${task.id}`}
              onOpenComment={() => onOpenComment(`task:${day.date}:${task.id}`)}
              onCloseComment={onCloseComment}
              onToggleReview={() => onToggleTask(task)}
              onAddComment={text => onAddTaskComment(task.id, text)}
              editable={editable}
              onUpdateTask={updates => onUpdateTask(task.id, updates)}
              onToggleCompletion={() => onToggleCompletion(task.id)}
              defaultExpanded={task.id === justAddedId}
              defaultEditingTitle={task.id === justAddedId}
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
  const updateTask = useAppStore(s => s.updateTask)
  const addTaskForDate = useAppStore(s => s.addTaskForDate)
  const updateJournalEntry = useAppStore(s => s.updateJournalEntry)
  const syncAllJournals = useAppStore(s => s.syncAllJournals)
  const [journalDocs, setJournalDocs] = useState([])
  const [selectedDate, setSelectedDate] = useState(null)
  const [mobileView, setMobileView] = useState('list')
  const [mobilePanel, setMobilePanel] = useState('journal')
  const [openCommentKey, setOpenCommentKey] = useState(null)
  const [mode, setMode] = useState('review') // 'review' | 'edit'
  const todayStr = today()

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

  const handleUpdateJournalBlock = async (blockId, html) => {
    if (!selectedDay) return
    const priorBlocks = selectedDay.journalEntry?.blocks || []
    
    // Parse the incoming HTML to extract blocks. 
    // We use a temporary container to let htmlToBlocks do the work.
    const container = document.createElement('div')
    container.innerHTML = html
    
    // If TipTap returned multiple top-level blocks (e.g. user pressed Enter),
    // we need to preserve them as separate blocks so they can be commented on individually.
    const incomingBlocks = Array.from(container.children).map((child, i) => {
      const bid = child.getAttribute('data-bid') || (i === 0 && blockId !== 'initial-block' ? blockId : uuid())
      return {
        id: bid,
        html: child.outerHTML,
        updatedAt: new Date().toISOString()
      }
    })

    let nextBlocks
    if (blockId === 'initial-block' && priorBlocks.length === 0) {
      nextBlocks = incomingBlocks
    } else {
      // Replace the old block with the new set of blocks
      const idx = priorBlocks.findIndex(b => b.id === blockId)
      if (idx === -1) {
        nextBlocks = [...priorBlocks, ...incomingBlocks]
      } else {
        nextBlocks = [...priorBlocks]
        nextBlocks.splice(idx, 1, ...incomingBlocks)
      }
    }

    await updateJournalEntry(selectedDay.date, { blocks: nextBlocks })
    
    // Unreview if edited
    if (selectedDay.journalReviewed) {
      await setJournalEntryReviewed(selectedDay.date, false)
    }
  }

  const handleUpdateTask = async (taskId, updates) => {
    if (!selectedDay) return
    await updateTask(taskId, updates)
    // Unreview if edited
    const task = selectedDay.tasks.find(t => t.id === taskId)
    if (task?.reviewed) {
      await setTaskReviewedForDate(taskId, selectedDay.date, false)
    }
  }

  const handleToggleTaskCompletion = async (taskId) => {
    if (!selectedDay) return
    const snapshot = selectedDay.tasks.find(t => t.id === taskId)
    if (!snapshot) return

    const isNowDone = !snapshot.completed
    await updateTask(taskId, {
      status: isNowDone ? 'done' : 'active',
      doneDate: isNowDone ? selectedDay.date : null
    })

    // Unreview if changed
    if (snapshot.reviewed) {
      await setTaskReviewedForDate(taskId, selectedDay.date, false)
    }
  }

  const handleAddTask = async (title) => {
    if (!selectedDay) return
    return await addTaskForDate(title, selectedDay.date)
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
              <button
                onClick={() => setMode(m => m === 'review' ? 'edit' : 'review')}
                style={modeToggleStyle(mode)}
              >
                {mode === 'review' ? 'Review' : 'Edit'}
              </button>
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
              <button
                onClick={() => setMode(m => m === 'review' ? 'edit' : 'review')}
                style={modeToggleStyle(mode)}
              >
                {mode === 'review' ? 'Review' : 'Edit'}
              </button>
            </header>

            <div className="hidden md:flex" style={{ flex: 1, minHeight: 0 }}>
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-light)' }}>
                <ReviewJournalPane
                  day={selectedDay}
                  openCommentKey={openCommentKey}
                  onOpenComment={setOpenCommentKey}
                  onCloseComment={() => setOpenCommentKey(null)}
                  onToggleReview={() => setJournalEntryReviewed(selectedDay.date, !selectedDay.journalReviewed)}
                  onAddBlockComment={(blockId, text) => addJournalBlockComment(selectedDay.date, blockId, text)}
                  editable={mode === 'edit'}
                  onUpdateBlock={handleUpdateJournalBlock}
                />
              </div>
              <div style={{ width: '360px', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <TasksReviewPane
                  day={selectedDay}
                  openCommentKey={openCommentKey}
                  onOpenComment={setOpenCommentKey}
                  onCloseComment={() => setOpenCommentKey(null)}
                  onToggleTask={task => setTaskReviewedForDate(task.id, selectedDay.date, !task.reviewed)}
                  onAddTaskComment={(taskId, text) => addTaskReviewComment(taskId, selectedDay.date, text)}
                  editable={mode === 'edit'}
                  onUpdateTask={handleUpdateTask}
                  onToggleCompletion={handleToggleTaskCompletion}
                  onAddTask={handleAddTask}
                />
              </div>
            </div>

            <div className="md:hidden" style={{ flex: 1, overflow: 'hidden' }}>
              {mobilePanel === 'journal' ? (
                <ReviewJournalPane
                  day={selectedDay}
                  openCommentKey={openCommentKey}
                  onOpenComment={setOpenCommentKey}
                  onCloseComment={() => setOpenCommentKey(null)}
                  onToggleReview={() => setJournalEntryReviewed(selectedDay.date, !selectedDay.journalReviewed)}
                  onAddBlockComment={(blockId, text) => addJournalBlockComment(selectedDay.date, blockId, text)}
                  editable={mode === 'edit'}
                  onUpdateBlock={handleUpdateJournalBlock}
                />
              ) : (
                <TasksReviewPane
                  day={selectedDay}
                  openCommentKey={openCommentKey}
                  onOpenComment={setOpenCommentKey}
                  onCloseComment={() => setOpenCommentKey(null)}
                  onToggleTask={task => setTaskReviewedForDate(task.id, selectedDay.date, !task.reviewed)}
                  onAddTaskComment={(taskId, text) => addTaskReviewComment(taskId, selectedDay.date, text)}
                  editable={mode === 'edit'}
                  onUpdateTask={handleUpdateTask}
                  onToggleCompletion={handleToggleTaskCompletion}
                  onAddTask={handleAddTask}
                />
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

function modeToggleStyle(mode) {
  const isReview = mode === 'review'
  return {
    padding: '6px 16px',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    background: isReview ? 'var(--green-500)' : '#EAB308', // Warm yellow
    color: isReview ? 'white' : 'white',
    boxShadow: isReview 
      ? '0 2px 8px rgba(34,197,94,0.3)' 
      : '0 2px 8px rgba(234,179,8,0.3)',
  }
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
    padding: '14px',
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

const addTaskInputStyle = {
  width: '100%',
  borderRadius: '10px',
  border: '1px dashed var(--border-mid)',
  background: 'transparent',
  color: 'var(--text-primary)',
  padding: '10px 14px',
  fontSize: '13px',
  fontFamily: 'var(--font-body)',
  outline: 'none',
  textAlign: 'start',
  transition: 'all 0.2s ease',
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
