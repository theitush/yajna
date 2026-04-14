import { NavLink } from 'react-router-dom'
import useAppStore from '../../store/useAppStore'
import { putMeta } from '../../services/db'
import { MODE_KEY, MODE_OFFLINE } from '../../lib/constants'

const items = [
  { to: '/', label: 'Today', icon: BookIcon },
  { to: '/notes', label: 'Notes', icon: HashIcon },
  { to: '/journal', label: 'History', icon: CalendarIcon },
  { to: '/tasks', label: 'Todos', icon: CheckIcon },
]

export default function Sidebar() {
  const syncing = useAppStore(s => s.syncing)
  const mode = useAppStore(s => s.mode)
  const setAuthenticated = useAppStore(s => s.setAuthenticated)
  const isOnline = mode !== MODE_OFFLINE

  const handleConnectDrive = async () => {
    await putMeta(MODE_KEY, null)
    setAuthenticated(false)
  }

  return (
    <aside style={{
      width: '200px',
      flexShrink: 0,
      borderRight: '1px solid var(--border-light)',
      background: 'var(--bg-primary)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }} className="hidden md:flex">
      {/* Brand */}
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border-light)' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: '26px',
          fontWeight: 400,
          letterSpacing: '-0.5px',
          color: 'var(--text-primary)',
          lineHeight: 1,
        }}>
          Yajna
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px', letterSpacing: '0.3px' }}>
          journal · notes · todos
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '6px' }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: isOnline ? 'var(--green-500)' : 'var(--border-mid)',
            display: 'inline-block',
          }} />
          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            {syncing ? 'syncing…' : isOnline ? 'online' : 'offline'}
          </span>
          {!isOnline && (
            <button
              onClick={handleConnectDrive}
              title="Connect Google Drive"
              style={{
                marginLeft: '2px',
                padding: '1px 4px',
                fontSize: '10px',
                color: 'var(--accent)',
                background: 'transparent',
                border: '1px solid var(--accent)',
                borderRadius: '3px',
                cursor: 'pointer',
                lineHeight: 1.4,
                fontFamily: 'var(--font-body)',
              }}
            >
              connect
            </button>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: '8px 0', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-tertiary)', padding: '10px 20px 4px', fontWeight: 500 }}>
          Navigate
        </div>
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 20px',
              fontSize: '13px',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: isActive ? 500 : 400,
              background: isActive ? 'var(--bg-secondary)' : 'transparent',
              borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              textDecoration: 'none',
              transition: 'all 0.15s',
            })}
          >
            <Icon />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Settings at bottom */}
      <NavLink
        to="/settings"
        style={({ isActive }) => ({
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '9px 20px',
          fontSize: '13px',
          color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: isActive ? 500 : 400,
          background: isActive ? 'var(--bg-secondary)' : 'transparent',
          borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
          textDecoration: 'none',
          transition: 'all 0.15s',
          borderTop: '1px solid var(--border-light)',
        })}
      >
        <GearIcon />
        Settings
      </NavLink>
    </aside>
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
function GearIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ opacity: 0.6, flexShrink: 0 }}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
}
