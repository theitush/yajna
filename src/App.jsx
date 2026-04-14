import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import useAppStore from './store/useAppStore'
import { loadGIS, loadGAPI, initGAPI, getStoredToken, requestToken, setAccessToken } from './services/auth'
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
    setMode, runInitialSync, bootOffline, loadJournal,
  } = useAppStore()
  const [loginLoading, setLoginLoading] = useState(false)
  const [initError, setInitError] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    async function bootstrap() {
      try {
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
          await Promise.all([loadGIS(), loadGAPI()])
          await initGAPI()
          const token = await getStoredToken()
          if (token) {
            setAccessToken(token)
            await finishDriveAuth()
            return
          }
          // Token expired — fall through to login screen
        }

        // No saved mode or no client id configured: show login
        if (GOOGLE_CLIENT_ID) {
          // Pre-load GIS/GAPI in the background so sign-in is faster
          Promise.all([loadGIS(), loadGAPI()])
            .then(() => initGAPI())
            .catch(() => {})
        }
      } catch (e) {
        console.error('Bootstrap error', e)
        setInitError('Something went wrong loading the app.')
      } finally {
        setInitializing(false)
      }
    }
    bootstrap()
  }, [])

  async function finishDriveAuth() {
    setMode(MODE_DRIVE)
    await putMeta(MODE_KEY, MODE_DRIVE)
    await initDriveStructure()
    await runInitialSync()
    await loadJournal(weekKey(today()))
    setAuthenticated(true)
  }

  const handleLogin = async () => {
    setLoginLoading(true)
    setInitError(null)
    // Safety timeout: if login takes more than 60s, unblock the UI
    const timeout = setTimeout(() => {
      setLoginLoading(false)
      setInitError('Sign-in timed out. Please try again.')
    }, 60_000)
    try {
      // Make sure GIS/GAPI are loaded (may already be if pre-loaded)
      await Promise.all([loadGIS(), loadGAPI()])
      await initGAPI()
      const token = await requestToken(true)
      setAccessToken(token)
      await finishDriveAuth()
    } catch (e) {
      console.error('Login failed', e)
      const msg = (e?.message === 'popup_closed_by_user' || e?.message === 'popup_closed')
        ? 'Sign-in cancelled.'
        : 'Sign-in failed. Please try again.'
      setInitError(msg)
    } finally {
      clearTimeout(timeout)
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
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 400, color: 'var(--text-primary)' }}>Yajna</span>
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
