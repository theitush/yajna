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
import BottomNav from './components/layout/BottomNav'

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
    try {
      // Make sure GIS/GAPI are loaded (may already be if pre-loaded)
      await Promise.all([loadGIS(), loadGAPI()])
      await initGAPI()
      const token = await requestToken()
      setAccessToken(token)
      await finishDriveAuth()
    } catch (e) {
      console.error('Login failed', e)
      setInitError('Sign-in failed. Please try again.')
    } finally {
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
      <div className="flex items-center justify-center h-full">
        <div className="w-5 h-5 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="h-full flex flex-col">
        {initError && (
          <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs px-4 py-2 text-center">
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
        <Sidebar />
        <main className="flex-1 overflow-hidden flex flex-col pb-16 md:pb-0">
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/journal" element={<JournalPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
        <BottomNav />
      </div>
    </HashRouter>
  )
}
