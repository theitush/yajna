import { NavLink } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import useAppStore, { retryNow } from '../../store/useAppStore'
import { putMeta } from '../../services/db'
import { MODE_KEY, MODE_OFFLINE, MODE_DRIVE } from '../../lib/constants'
import { getAllJournals } from '../../services/db'
import { buildReviewDays } from '../../lib/review'

const baseItems = [
  { to: '/', label: 'Today', icon: BookIcon },
  { to: '/notes', label: 'Notes', icon: HashIcon },
  { to: '/tasks', label: 'Todos', icon: CheckIcon },
  { to: '/review', label: 'Review', icon: CalendarIcon },
  { to: '/trash', label: 'Trash', icon: TrashIcon },
]

function statusDot(syncStatus) {
  switch (syncStatus.state) {
    case 'synced': return 'var(--green-500)'
    case 'syncing': return 'var(--accent)'
    case 'waiting': return 'var(--yellow-500, #eab308)'
    default: return 'var(--border-mid)'
  }
}

function statusLabel(syncStatus) {
  switch (syncStatus.state) {
    case 'synced': return 'synced'
    case 'syncing': return 'syncing\u2026'
    case 'waiting': return `retrying in ${syncStatus.retryIn}s`
    default: return 'offline'
  }
}

function SidebarContent({ onNav, syncStatus, handleConnectDrive }) {
  const tasks = useAppStore(s => s.tasks)
  const reviews = useAppStore(s => s.reviews)
  const reviewVersion = useAppStore(s => s.reviewVersion)
  const [journalDocs, setJournalDocs] = useState([])
  const isClickable = syncStatus.state === 'waiting' || syncStatus.state === 'offline'
  const isDriveMode = useAppStore(s => s.mode === MODE_DRIVE)

  const reviewCount = useMemo(
    () => buildReviewDays({ tasks, journalDocs, reviews }).filter(day => day.needsReview).length,
    [tasks, journalDocs, reviews]
  )
  const items = useMemo(
    () => baseItems.map(item => item.to === '/review'
      ? { ...item, label: reviewCount > 0 ? `Review (${reviewCount})` : 'Review' }
      : item),
    [reviewCount]
  )

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

  const handleClick = () => {
    if (!isClickable) return
    if (isDriveMode && syncStatus.state === 'offline') {
      retryNow()
    } else if (syncStatus.state === 'offline') {
      handleConnectDrive()
    } else {
      retryNow()
    }
  }

  return (
    <>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border-light)' }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 400,
          letterSpacing: '-0.5px', color: 'var(--text-primary)', lineHeight: 1,
        }}>
          Yajna
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px', letterSpacing: '0.3px' }}>
          journal · notes · todos
        </div>
        <div
          onClick={handleClick}
          title={isClickable ? 'Click to retry now' : undefined}
          style={{
            display: 'flex', alignItems: 'center', gap: '5px', marginTop: '6px',
            cursor: isClickable ? 'pointer' : 'default',
            userSelect: 'none',
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: statusDot(syncStatus),
            display: 'inline-block',
            ...(syncStatus.state === 'syncing' ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}),
          }} />
          <span style={{
            fontSize: '11px',
            color: 'var(--text-tertiary)',
          }}>
            {statusLabel(syncStatus)}
          </span>
        </div>
      </div>

      <nav style={{ padding: '8px 0', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-tertiary)', padding: '10px 20px 4px', fontWeight: 500 }}>
          Navigate
        </div>
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} onClick={onNav}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 20px',
              fontSize: '13px',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: isActive ? 500 : 400,
              background: isActive ? 'var(--bg-secondary)' : 'transparent',
              borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              textDecoration: 'none', transition: 'all 0.15s',
            })}
          >
            <Icon />{label}
          </NavLink>
        ))}
      </nav>

      <NavLink to="/settings" onClick={onNav}
        style={({ isActive }) => ({
          display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 20px',
          fontSize: '13px',
          color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: isActive ? 500 : 400,
          background: isActive ? 'var(--bg-secondary)' : 'transparent',
          borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
          textDecoration: 'none', transition: 'all 0.15s',
          borderTop: '1px solid var(--border-light)',
        })}
      >
        <GearIcon />Settings
      </NavLink>
    </>
  )
}

export default function Sidebar({ open, onClose }) {
  const syncStatus = useAppStore(s => s.syncStatus)
  const mode = useAppStore(s => s.mode)
  const setAuthenticated = useAppStore(s => s.setAuthenticated)

  const handleConnectDrive = async () => {
    await putMeta(MODE_KEY, null)
    setAuthenticated(false)
  }

  // If in offline mode (user chose offline), always show offline
  const effectiveStatus = mode === MODE_OFFLINE ? { state: 'offline' } : syncStatus

  const props = { syncStatus: effectiveStatus, handleConnectDrive }

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div onClick={onClose} className="mobile-only" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300,
        }} />
      )}

      {/* Mobile drawer */}
      <aside className="mobile-only" style={{
        position: 'fixed', top: 0, left: 0, bottom: 0, width: '220px',
        background: 'var(--bg-primary)', borderRight: '1px solid var(--border-light)',
        display: 'flex', flexDirection: 'column', zIndex: 400,
        transform: open ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.25s ease',
      }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: '12px', right: '12px',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-tertiary)', padding: '4px', lineHeight: 1,
        }}>
          <CloseIcon />
        </button>
        <SidebarContent {...props} onNav={onClose} />
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex" style={{
        width: '200px', flexShrink: 0,
        borderRight: '1px solid var(--border-light)',
        background: 'var(--bg-primary)', flexDirection: 'column', height: '100%',
      }}>
        <SidebarContent {...props} onNav={null} />
      </aside>
    </>
  )
}

function BookIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.6, flexShrink: 0 }}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
}
function CalendarIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.6, flexShrink: 0 }}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
}
function HashIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.6, flexShrink: 0 }}><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>
}
function CheckIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.6, flexShrink: 0 }}><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
}
function TrashIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.6, flexShrink: 0 }}><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
}
function GearIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.6, flexShrink: 0 }}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
}
function CloseIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
}
