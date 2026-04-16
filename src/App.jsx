import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import useAppStore from './store/useAppStore'
import { loadGAPI, initGAPI, getStoredToken, getTokenRemainingSeconds, startAuthRedirect, consumeAuthRedirect, storeToken, setAccessToken, trySilentRefresh, scheduleTokenRefresh } from './services/auth'
import { initDriveStructure } from './services/drive'
import { getMeta, putMeta } from './services/db'
import { requestStoragePersistence } from './services/storage'
import { GOOGLE_CLIENT_ID, MODE_DRIVE, MODE_OFFLINE, MODE_KEY } from './lib/constants'
import { weekKey, today } from './lib/dates'

import LoginScreen from './components/auth/LoginScreen'
import Sidebar from './components/layout/Sidebar'

import TodayPage from './pages/TodayPage'
import JournalPage from './pages/JournalPage'
import NotesPage from './pages/NotesPage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  const {
    isAuthenticated, isInitializing,
    setAuthenticated, setInitializing,
    setMode, runInitialSync, bootOffline, loadJournal, fetchUserEmail, setSyncStatus,
  } = useAppStore()
  const syncStatus = useAppStore(s => s.syncStatus)
  const mode = useAppStore(s => s.mode)
  const [loginLoading, setLoginLoading] = useState(false)
  const [initError, setInitError] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
          await putMeta(MODE_KEY, MODE_DRIVE)
          setMode(MODE_DRIVE)
          await bootOffline()
          await loadJournal(weekKey(today()))
          setAuthenticated(true)

          // Finish Drive setup in background
          setSyncStatus({ state: 'syncing' })
          ;(async () => {
            try {
              await loadGAPI()
              await initGAPI()
              setAccessToken(redirectResult.token)
              scheduleTokenRefresh(redirectResult.expiresIn, handleTokenExpired)
              fetchUserEmail()
              await initDriveStructure()
              await runInitialSync()
              await loadJournal(weekKey(today()))
            } catch (e) {
              console.error('Background Drive init after redirect failed:', e)
            }
          })()
          return
        }

        // Check if a mode was already chosen in a previous session
        const savedMode = await getMeta(MODE_KEY)

        if (savedMode === MODE_OFFLINE) {
          setMode(MODE_OFFLINE)
          await bootOffline()
          await loadJournal(weekKey(today()))
          setAuthenticated(true)
          return
        }

        if (savedMode === MODE_DRIVE && GOOGLE_CLIENT_ID) {
          // Show the app immediately from local data
          setMode(MODE_DRIVE)
          await bootOffline()
          await loadJournal(weekKey(today()))
          setAuthenticated(true)

          // Connect to Drive in the background — app is already usable
          setSyncStatus({ state: 'syncing' })
          ;(async () => {
            try {
              await loadGAPI()
              await initGAPI()
              const token = await getStoredToken()
              if (token) {
                setAccessToken(token)
                scheduleTokenRefresh(await getTokenRemainingSeconds(), handleTokenExpired)
                fetchUserEmail()
                await initDriveStructure()
                await runInitialSync()
                await loadJournal(weekKey(today()))
                return
              }
              // Token expired — try silent refresh
              const refreshed = await trySilentRefresh()
              if (refreshed) {
                await storeToken(refreshed.token, refreshed.expiresIn)
                setAccessToken(refreshed.token)
                scheduleTokenRefresh(refreshed.expiresIn, handleTokenExpired)
                fetchUserEmail()
                await initDriveStructure()
                await runInitialSync()
                await loadJournal(weekKey(today()))
                return
              }
              // Silent refresh failed — session expired
              handleTokenExpired()
            } catch (e) {
              console.error('Background Drive connect failed:', e)
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
        setInitError('Something went wrong loading the app.')
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
        const refreshed = await trySilentRefresh()
        if (refreshed) {
          await storeToken(refreshed.token, refreshed.expiresIn)
          setAccessToken(refreshed.token)
          scheduleTokenRefresh(refreshed.expiresIn, handleTokenExpired)
        } else {
          handleTokenExpired()
        }
      })()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

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
    await loadJournal(weekKey(today()))
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
              <Route path="/" element={<TodayPage />} />
              <Route path="/journal" element={<JournalPage />} />
              <Route path="/notes" element={<NotesPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </HashRouter>
  )
}
