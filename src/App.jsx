import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import useAppStore from './store/useAppStore'
import { loadGAPI, initGAPI, getStoredToken, getTokenRemainingSeconds, startAuthRedirect, consumeAuthRedirect, storeToken, storeRefreshBlob, setAccessToken, trySilentRefresh, scheduleTokenRefresh, isAuthError } from './services/auth'
import { initDriveStructure } from './services/drive'
import { migrateDriveJournalsIfNeeded } from './services/journalMigration'
import { getMeta, putMeta } from './services/db'
import { requestStoragePersistence } from './services/storage'
import { GOOGLE_CLIENT_ID, MODE_DRIVE, MODE_OFFLINE, MODE_KEY } from './lib/constants'

import LoginScreen from './components/auth/LoginScreen'
import Sidebar from './components/layout/Sidebar'

import TodayPage from './pages/TodayPage'
import ReviewPage from './pages/ReviewPage'
import NotesPage from './pages/NotesPage'
import TasksPage from './pages/TasksPage'
import TrashPage from './pages/TrashPage'
import SearchPage from './pages/SearchPage'
import SettingsPage from './pages/SettingsPage'
import SurfaceLoadingGate from './components/layout/SurfaceLoadingGate'

export default function App() {
  const {
    isAuthenticated, isInitializing, initError,
    setAuthenticated, setInitializing, setInitError,
    setMode, runInitialSync, bootOffline, loadJournal, fetchUserEmail, setSyncStatus,
  } = useAppStore()
  const syncStatus = useAppStore(s => s.syncStatus)
  const mode = useAppStore(s => s.mode)
  const coldPull = useAppStore(s => s.coldPull)
  const [loginLoading, setLoginLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [blockingInitialSync, setBlockingInitialSync] = useState(false)

  // Map the active route to the buckets/journal it needs to render. Used
  // at boot to decide what to wait for before releasing the global spinner.
  // Phase B: per-surface gates take over once the global spinner drops, so
  // most routes only need to wait for Stage 1 (`today`) to unblock the UI
  // shell — tasks/notes finish behind a surface-gated overlay.
  function priorityWorkForRoute(hash) {
    // Strip leading "#" and query/fragment leftovers.
    const path = (hash || '').replace(/^#/, '').split('?')[0] || '/'
    if (path.startsWith('/settings')) return { buckets: ['config'], journal: false }
    // Today (/, /journal, /review): just wait for Stage 1.
    if (path.startsWith('/review')) return { buckets: ['today'], journal: true }
    // Tasks/Notes/Trash: drop the global spinner after Stage 1; the surface
    // gate keeps its own overlay until the specific bucket lands.
    return { buckets: ['today'], journal: path === '/' || path.startsWith('/journal') }
  }

  const effectiveSyncStatus = mode === MODE_OFFLINE ? { state: 'offline' } : syncStatus
  const syncDotColor = {
    synced: 'var(--green-500)',
    syncing: 'var(--accent)',
    waiting: 'var(--yellow-500, #eab308)',
  }[effectiveSyncStatus.state] || 'var(--border-mid)'

  function handleTokenExpired() {
    setAuthenticated(false)
    setInitError('Session expired. Please sign in again.')
  }

  useEffect(() => {
    async function bootstrap() {
      try {
        // Handle OAuth redirect response first — must run before HashRouter
        // reads the URL fragment, since the OAuth response uses the fragment.
        const redirectResult = consumeAuthRedirect()
        if (redirectResult) {
          // Store token immediately — GAPI load can be slow
          await storeToken(redirectResult.token, redirectResult.expiresIn)
          await storeRefreshBlob(redirectResult.refreshBlob)
          await putMeta(MODE_KEY, MODE_DRIVE)
          setMode(MODE_DRIVE)
          await bootOffline()
          await loadJournal()
          setAuthenticated(true)

          // Finish Drive setup in background
          setBlockingInitialSync(true)
          setSyncStatus({ state: 'syncing' })
          ;(async () => {
            try {
              await loadGAPI()
              await initGAPI()
              setAccessToken(redirectResult.token)
              scheduleTokenRefresh(redirectResult.expiresIn, handleTokenExpired)
              fetchUserEmail()
              await initDriveStructure()
              await migrateDriveJournalsIfNeeded().catch(e => console.warn('journal migration failed (will retry next boot):', e))
              const work = priorityWorkForRoute(window.location.hash)
              const priorityTasks = [runInitialSync({ priorityBuckets: work.buckets })]
              if (work.journal) priorityTasks.push(loadJournal())
              await Promise.all(priorityTasks)
              // After the merge lands, refresh today's journal from IDB so
              // currentDay reflects whatever Stage 4 pulled. The initial
              // loadJournal ran before Drive folder ids existed and only saw
              // the empty local stub.
              await loadJournal()
            } catch (e) {
              console.error('Background Drive init after redirect failed:', e)
              if (isAuthError(e)) {
                setSyncStatus({ state: 'error', message: 'Session expired', isAuth: true })
              } else {
                setSyncStatus({ state: 'offline' })
              }
            } finally {
              setBlockingInitialSync(false)
            }
          })()
          return
        }

        // Check if a mode was already chosen in a previous session
        const savedMode = await getMeta(MODE_KEY)

        if (savedMode === MODE_OFFLINE) {
          setMode(MODE_OFFLINE)
          await bootOffline()
          await loadJournal()
          setAuthenticated(true)
          return
        }

        if (savedMode === MODE_DRIVE && GOOGLE_CLIENT_ID) {
          // Show the app immediately from local data
          setMode(MODE_DRIVE)
          await bootOffline()
          await loadJournal()
          setAuthenticated(true)

          // Connect to Drive in the background — app is already usable
          setBlockingInitialSync(true)
          setSyncStatus({ state: 'syncing' })
          ;(async () => {
            const tBoot = performance.now()
            const lap = (label, from) => { console.log(`[boot] ${label}: ${(performance.now() - from).toFixed(0)}ms`); return performance.now() }
            try {
              let t = performance.now()
              await loadGAPI(); t = lap('loadGAPI', t)
              await initGAPI(); t = lap('initGAPI', t)
              const token = await getStoredToken(); t = lap('getStoredToken', t)
              if (token) {
                setAccessToken(token)
                scheduleTokenRefresh(await getTokenRemainingSeconds(), handleTokenExpired)
                fetchUserEmail(); t = lap('fetchUserEmail (kicked off)', t)
                await initDriveStructure(); t = lap('initDriveStructure', t)
                await migrateDriveJournalsIfNeeded().catch(e => console.warn('journal migration failed (will retry next boot):', e)); t = lap('journal migration', t)
                const work = priorityWorkForRoute(window.location.hash)
                const priorityTasks = [runInitialSync({ priorityBuckets: work.buckets })]
                if (work.journal) priorityTasks.push(loadJournal())
                await Promise.all(priorityTasks); t = lap('priority sync', t)
                lap('TOTAL boot gate', tBoot)
                return
              }
              // Token expired — try silent refresh
              try {
                const refreshed = await trySilentRefresh()
                if (refreshed) {
                  await storeToken(refreshed.token, refreshed.expiresIn)
                  setAccessToken(refreshed.token)
                  scheduleTokenRefresh(refreshed.expiresIn, handleTokenExpired)
                  fetchUserEmail()
                  await initDriveStructure()
                  const work = priorityWorkForRoute(window.location.hash)
                  const priorityTasks = [runInitialSync({ priorityBuckets: work.buckets })]
                  if (work.journal) priorityTasks.push(loadJournal())
                  await Promise.all(priorityTasks)
                  return
                }
                // Silent refresh returned null — permanent failure (401)
                handleTokenExpired()
              } catch (e) {
                console.warn('Background Drive connect network error:', e)
                if (isAuthError(e)) {
                  setSyncStatus({ state: 'error', message: 'Session expired', isAuth: true })
                } else {
                  setSyncStatus({ state: 'offline' })
                }
              }
            } catch (e) {
              console.error('Background Drive connect failed:', e)
              if (isAuthError(e)) {
                setSyncStatus({ state: 'error', message: 'Session expired', isAuth: true })
              } else {
                setSyncStatus({ state: 'offline' })
              }
            } finally {
              setBlockingInitialSync(false)
            }
          })()
          return
        }

        // No saved mode or no client id configured: show login
        if (GOOGLE_CLIENT_ID) {
          // Pre-load GAPI in the background so post-redirect init is faster
          loadGAPI().then(() => initGAPI()).catch(() => {})
        }
      } catch (e) {
        console.error('Bootstrap error', e)
        const detail = e?.message || String(e)
        setInitError(`Something went wrong loading the app: ${detail}`)
      } finally {
        setInitializing(false)
      }
    }
    bootstrap()

    // When the tab wakes from sleep/background, check if token needs refresh
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      ;(async () => {
        const savedMode = await getMeta(MODE_KEY)
        if (savedMode !== MODE_DRIVE) return
        const token = await getStoredToken()
        if (token) {
          // Token still valid — reschedule refresh for remaining time
          scheduleTokenRefresh(await getTokenRemainingSeconds(), handleTokenExpired)
          return
        }
        // Token expired while tab was backgrounded — try silent refresh
        try {
          const refreshed = await trySilentRefresh()
          if (refreshed) {
            await storeToken(refreshed.token, refreshed.expiresIn)
            setAccessToken(refreshed.token)
            scheduleTokenRefresh(refreshed.expiresIn, handleTokenExpired)
          } else {
            // null means permanent failure (401)
            handleTokenExpired()
          }
        } catch (e) {
          console.warn('Visibility change refresh network error:', e)
          if (isAuthError(e)) {
            setSyncStatus({ state: 'error', message: 'Session expired', isAuth: true })
          } else {
            setSyncStatus({ state: 'offline' })
          }
        }
      })()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  useEffect(() => {
    // Only steal focus during a cold pull, where edits would clobber an
    // empty stub. Warm syncs let the user keep typing.
    if (!coldPull?.active) return
    const el = document.activeElement
    if (el && typeof el.blur === 'function') el.blur()
  }, [coldPull?.active])

  const handleLogin = async () => {
    setLoginLoading(true)
    setInitError(null)
    try {
      // Redirects the whole tab to Google; execution stops here on success.
      await startAuthRedirect()
    } catch (e) {
      console.error('Login failed', e)
      setInitError('Sign-in failed. Please try again.')
      setLoginLoading(false)
    }
  }

  const handleOffline = async () => {
    setMode(MODE_OFFLINE)
    await putMeta(MODE_KEY, MODE_OFFLINE)

    // Request persistent storage — best effort
    await requestStoragePersistence()

    await bootOffline()
    await loadJournal()
    setAuthenticated(true)
  }

  if (isInitializing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--bg-primary)' }}>
        <div style={{ width: 20, height: 20, border: '2px solid var(--border-mid)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
        {initError && (
          <div style={{ background: 'rgba(239,68,68,0.1)', color: '#FCA5A5', fontSize: '12px', padding: '8px 16px', textAlign: 'center' }}>
            {initError}
          </div>
        )}
        <LoginScreen onLogin={handleLogin} onOffline={handleOffline} loading={loginLoading} />
      </div>
    )
  }

  return (
    <HashRouter>
      <div className="flex h-full overflow-hidden">
        <Sidebar open={sidebarOpen} onOpen={() => setSidebarOpen(true)} onClose={() => setSidebarOpen(false)} />
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Mobile top bar */}
          <div className="mobile-only" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '0 16px',
            height: '48px',
            borderBottom: '1px solid var(--border-light)',
            flexShrink: 0,
          }}>
            <button
              onClick={() => setSidebarOpen(true)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 400, color: 'var(--text-primary)' }}>Yajna</span>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: syncDotColor,
                display: 'inline-block',
                flexShrink: 0,
                marginTop: '12px', 
                ...(effectiveSyncStatus.state === 'syncing' ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}),
              }} />
            </span>
          </div>
          <main className="flex-1 overflow-hidden flex flex-col">
            <Routes>
              <Route path="/" element={
                <SurfaceLoadingGate bucket="today" label="Loading today..."><TodayPage /></SurfaceLoadingGate>
              } />
              <Route path="/review" element={
                <SurfaceLoadingGate bucket="tasks" label="Loading..."><ReviewPage /></SurfaceLoadingGate>
              } />
              <Route path="/journal" element={<Navigate to="/review" replace />} />
              <Route path="/notes" element={
                <SurfaceLoadingGate bucket="notes" label="Loading notes..."><NotesPage /></SurfaceLoadingGate>
              } />
              <Route path="/tasks" element={
                <SurfaceLoadingGate bucket="tasks" label="Loading tasks..."><TasksPage /></SurfaceLoadingGate>
              } />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/trash" element={
                <SurfaceLoadingGate bucket="notes" label="Loading..."><TrashPage /></SurfaceLoadingGate>
              } />
              <Route path="/settings" element={
                <SurfaceLoadingGate bucket="config" label="Loading settings..."><SettingsPage /></SurfaceLoadingGate>
              } />
            </Routes>
          </main>
        </div>
        {coldPull?.active && (
          <div
            // Cold-start ONLY: eat clicks until the full pull (every stage,
            // including journals) is done so the user can't edit empty stubs
            // before the real remote data lands. Warm sync overlays stay
            // pass-through — the user can keep working.
            onClickCapture={coldPull?.active ? (e => { e.stopPropagation(); e.preventDefault() }) : undefined}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10000,
              background: 'rgba(0,0,0,0.35)',
              backdropFilter: 'blur(2px)',
              cursor: coldPull?.active ? 'wait' : 'default',
              pointerEvents: coldPull?.active ? 'auto' : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, maxWidth: 320, textAlign: 'center', padding: '0 20px' }}>
              <div style={{ width: 22, height: 22, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              {coldPull?.active ? (
                <>
                  <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.95)', fontWeight: 500 }}>First-time setup on this device</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                    Pulling everything from Drive — this can take a few minutes. The app is locked until it's done so your edits don't conflict with what's being downloaded. Leave the app open.
                  </div>
                  <ColdPullProgress progress={coldPull.progress} />
                </>
              ) : (
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>Syncing...</div>
              )}
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
      </div>
    </HashRouter>
  )
}

function ColdPullProgress({ progress }) {
  const entries = Object.entries(progress || {})
  if (!entries.length) return null
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>
      {entries.map(([label, { current, total }]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, minWidth: 180 }}>
          <span style={{ textTransform: 'capitalize' }}>{label}</span>
          <span>{current}/{total}</span>
        </div>
      ))}
    </div>
  )
}
