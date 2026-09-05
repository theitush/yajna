import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import useAppStore from './store/useAppStore'
import useCurrentDay from './lib/useCurrentDay'
import { formatDate } from './lib/dates'
import { loadGAPI, initGAPI, getStoredToken, getTokenRemainingSeconds, startAuthRedirect, consumeAuthRedirect, storeToken, storeRefreshBlob, setAccessToken, trySilentRefresh, scheduleTokenRefresh, isAuthError, signOut } from './services/auth'
import { initDriveStructure } from './services/drive'
import { initEncryption, maybeAutoEnableOnFreshDrive, hasPendingEncMigration } from './services/encryption'
import { onEncStatusChange, getEncStatus } from './services/cryptoBox'
import { stopSyncEngine } from './services/syncEngine'
import { migrateDriveJournalsIfNeeded } from './services/journalMigration'
import { getMeta, putMeta } from './services/db'
import { requestStoragePersistence } from './services/storage'
import { GOOGLE_CLIENT_ID, MODE_DRIVE, MODE_OFFLINE, MODE_KEY, SYNC_PAUSED_KEY } from './lib/constants'

import LoginScreen from './components/auth/LoginScreen'
import UnlockScreen from './components/auth/UnlockScreen'
import RecoveryKeyModal from './components/auth/RecoveryKeyModal'
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
    markAllSyncReady,
  } = useAppStore()
  const syncStatus = useAppStore(s => s.syncStatus)
  const mode = useAppStore(s => s.mode)
  const coldPull = useAppStore(s => s.coldPull)
  const encState = useAppStore(s => s.encState)
  const pendingRecoveryKey = useAppStore(s => s.pendingRecoveryKey)
  const encMigration = useAppStore(s => s.encMigration)
  const [loginLoading, setLoginLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
          // Best effort: mark this origin's storage durable so Firefox can't
          // evict IDB data + the offline shell cache under disk pressure.
          requestStoragePersistence().catch(() => {})
          await bootOffline()
          await loadJournal()
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
              // Resolve at-rest encryption status before any migration/sync. A
              // locked device (encrypted Drive, no key here) stops now and shows
              // the UnlockScreen — pulling while locked would be reads-over-
              // unmerged-state. No enc_meta on Drive → 'plaintext' → passthrough.
              const encStatus = await initEncryption()
              useAppStore.getState().setEncState(encStatus)
              if (encStatus === 'locked') return
              // Brand-new Drive (no manifest yet → nothing to migrate): turn on
              // encryption from the start and show the recovery key once. An
              // existing account is left plaintext here — it enables via Settings
              // paired with the Stage-4 migration. Redirect path only: a fresh
              // Drive can only appear on a first sign-in.
              const recoveryKey = await maybeAutoEnableOnFreshDrive()
              if (recoveryKey) {
                useAppStore.getState().setEncState(getEncStatus())
                useAppStore.getState().setPendingRecoveryKey(recoveryKey)
              }
              // Resume an interrupted encryption migration BEFORE the first
              // merge/push can race its writes. No-op unless the persisted
              // resume flag is set (e.g. re-login after a crash mid-migration).
              await useAppStore.getState().runEncMigration({ resume: true })
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
                // Connect failed before runInitialSync could lift the surface
                // gates — release them so local data stays usable offline.
                markAllSyncReady()
              }
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
          // Best effort: durable storage for IDB + the offline shell cache.
          // No-op once granted; Firefox remembers a denial without re-prompting.
          requestStoragePersistence().catch(() => {})
          await bootOffline()
          await loadJournal()
          setAuthenticated(true)

          // Honor a manual "go offline" pause across reopens: if the user paused
          // sync last session, stay fully local and DON'T connect to Drive in the
          // background. Lift the surface gates so local data is editable, and
          // leave syncPaused set so driveEnabled blocks pushes until they resume.
          if (await getMeta(SYNC_PAUSED_KEY)) {
            useAppStore.setState({ syncPaused: true })
            setSyncStatus({ state: 'offline' })
            markAllSyncReady()
            // Resolve encryption status from the cached verdict even though we
            // skip the Drive connect: initEncryption fast-fails to the cache when
            // Drive is unreachable. Without this, cryptoBox stays 'undetermined'
            // and a later resume→push would hit the fail-closed write gate and
            // strand every push — even on a plaintext account.
            useAppStore.getState().setEncState(await initEncryption())
            return
          }

          // Connect to Drive in the background — app is already usable
          setSyncStatus({ state: 'syncing' })
          ;(async () => {
            // Definitely-offline fast path: don't make the user wait out a
            // network timeout behind the surface gates just to edit local
            // data. `onLine === false` is reliable (false = no network); the
            // connect attempt below still runs in case the flag is wrong —
            // gates are one-way so lifting them early here can't conflict.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
              setSyncStatus({ state: 'offline' })
              markAllSyncReady()
            }
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
                const encStatus = await initEncryption(); t = lap('initEncryption', t)
                useAppStore.getState().setEncState(encStatus)
                if (encStatus === 'locked') return // UnlockScreen takes over
                // Resume an interrupted encryption migration before any merge/push.
                await useAppStore.getState().runEncMigration({ resume: true })
                await migrateDriveJournalsIfNeeded().catch(e => console.warn('journal migration failed (will retry next boot):', e)); t = lap('journal migration', t)
                const work = priorityWorkForRoute(window.location.hash)
                const priorityTasks = [runInitialSync({ priorityBuckets: work.buckets })]
                if (work.journal) priorityTasks.push(loadJournal())
                await Promise.all(priorityTasks); lap('priority sync', t)
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
                  const encStatus = await initEncryption()
                  useAppStore.getState().setEncState(encStatus)
                  if (encStatus === 'locked') return // UnlockScreen takes over
                  // Resume an interrupted encryption migration before any merge/push.
                  await useAppStore.getState().runEncMigration({ resume: true })
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
                  // Connect failed before runInitialSync could lift the surface
                  // gates — release them so local data stays usable offline.
                  markAllSyncReady()
                }
              }
            } catch (e) {
              console.error('Background Drive connect failed:', e)
              if (isAuthError(e)) {
                setSyncStatus({ state: 'error', message: 'Session expired', isAuth: true })
              } else {
                setSyncStatus({ state: 'offline' })
                markAllSyncReady()
              }
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

    // Mirror mid-session encryption status changes into the store. The live
    // trigger is openContent's sniff-lock: a poll that reads sealed content with
    // no key flips status to 'locked', which surfaces the UnlockScreen without a
    // reload when another device enables encryption while this one is running.
    const unsubEnc = onEncStatusChange((next) => {
      useAppStore.getState().setEncState(next)
    })

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      unsubEnc()
    }
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

  // Escape hatch from the UnlockScreen: drop back to the login chooser (e.g. to
  // sign into the account that actually holds this Drive's key). Mirrors
  // SettingsPage's sign-out; the persisted key is left in IDB so re-login on this
  // same account still unlocks automatically.
  const handleSignOut = async () => {
    try { stopSyncEngine() } catch { /* not running */ }
    await signOut().catch(() => {})
    await putMeta(MODE_KEY, null)
    useAppStore.getState().setEncState(null)
    setAuthenticated(false)
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

  // Encrypted Drive, no key on this device: gate the whole app behind the
  // UnlockScreen. The connect paths returned before starting migration/sync, so
  // there's nothing running underneath — unlock persists the key and reloads.
  if (encState === 'locked') {
    return <UnlockScreen onSignOut={handleSignOut} />
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
              <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '10px' }}>{__APP_VERSION__}</span>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: syncDotColor,
                display: 'inline-block',
                flexShrink: 0,
                marginTop: '12px',
                ...(effectiveSyncStatus.state === 'syncing' ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}),
              }} />
            </span>
            <MobileTopbarDate />
          </div>
          <main className="flex-1 overflow-hidden flex flex-col">
            <Routes>
              <Route path="/" element={
                <SurfaceLoadingGate bucket="today" label="Loading today..."><TodayPage /></SurfaceLoadingGate>
              } />
              <Route path="/review" element={
                <SurfaceLoadingGate bucket={['journals', 'tasks']} label="Loading review..."><ReviewPage /></SurfaceLoadingGate>
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
        {pendingRecoveryKey && (
          <RecoveryKeyModal
            recoveryKey={pendingRecoveryKey}
            onDone={async () => {
              useAppStore.getState().setPendingRecoveryKey(null)
              // Settings enable flow on an existing account: the wizard armed
              // the migration flag before enabling, and the key is now saved —
              // seal everything already on Drive. Fresh-Drive auto-enable never
              // arms the flag (nothing to migrate), so this is a no-op there.
              if (await hasPendingEncMigration()) {
                useAppStore.getState().runEncMigration({})
              }
            }}
          />
        )}
        {encMigration && <EncMigrationOverlay migration={encMigration} />}
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
              {coldPull?.retrying ? (
                <>
                  <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.95)', fontWeight: 500 }}>Connection hiccup — retrying</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                    Some files didn't download on the first pass. Retrying automatically until everything lands — this needs a stable connection. Nothing is lost; the app unlocks as soon as the pull completes.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.95)', fontWeight: 500 }}>First-time setup on this device</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                    Pulling everything from Drive — this can take a few minutes and needs a stable connection. The app is locked until it's done so your edits don't conflict with what's being downloaded. Leave the app open.
                  </div>
                  <ColdPullProgress progress={coldPull.progress} />
                </>
              )}
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
      </div>
    </HashRouter>
  )
}

// The date shown next to "Yajna" in the mobile top bar. On Today it's the
// current day (from the rollover clock); on Review it's the selected day the
// page publishes to the store. Stands in for the per-screen date header we
// drop on mobile. Lives inside HashRouter so useLocation works.
function MobileTopbarDate() {
  const location = useLocation()
  const config = useAppStore(s => s.config)
  const today = useCurrentDay(config)
  const reviewDate = useAppStore(s => s.topbarDate)
  const date = location.pathname === '/' ? today
    : location.pathname === '/review' ? reviewDate
    : null
  if (!date) return null
  return (
    <span style={{
      marginLeft: 'auto',
      fontSize: '13px',
      color: 'var(--text-tertiary)',
      fontFamily: 'var(--font-body)',
      whiteSpace: 'nowrap',
    }}>
      {formatDate(date)}
    </span>
  )
}

/**
 * Blocking overlay for the one-shot encryption migration (Settings enable flow
 * or the boot auto-resume). While 'running' it eats all input — an edit made
 * mid-migration could be clobbered by an in-flight reseal (the migration
 * serializes the world instead of locking per file). 'done'/'error' keep the
 * overlay up, input-free, until dismissed.
 */
function EncMigrationOverlay({ migration }) {
  const { status, phase, done, total, summary, error } = migration
  const running = status === 'running'
  const summaryLine = summary
    ? [
        `${summary.sealed} file${summary.sealed === 1 ? '' : 's'} encrypted`,
        summary.skipped ? `${summary.skipped} already encrypted` : null,
        summary.deleted ? `${summary.deleted} old backup${summary.deleted === 1 ? '' : 's'} deleted` : null,
      ].filter(Boolean).join(', ')
    : null
  return (
    <div
      onClickCapture={running ? (e => { e.stopPropagation(); e.preventDefault() }) : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10500,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(2px)',
        cursor: running ? 'wait' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, maxWidth: 340, textAlign: 'center', padding: '0 20px' }}>
        {running ? (
          <>
            <div style={{ width: 22, height: 22, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.95)', fontWeight: 500 }}>Encrypting your Drive</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
              Every file already on Drive is being encrypted in place. Leave the app open until this finishes — closing it is safe (it resumes next launch), but nothing else should edit while it runs.
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>
              {total > 0 ? `${phase} — ${done}/${total}` : phase}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.95)', fontWeight: 500 }}>
              {status === 'done' ? 'Encryption complete ✓' : 'Encryption pass incomplete'}
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
              {status === 'done'
                ? (summaryLine || 'Your Drive data is now encrypted.')
                : error}
            </div>
            {status === 'error' && summaryLine && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>{summaryLine}</div>
            )}
            <button
              onClick={() => useAppStore.getState().dismissEncMigration()}
              style={{
                marginTop: 4, padding: '9px 26px',
                background: 'var(--accent)', border: 'none', borderRadius: '8px',
                color: '#fff', fontSize: 13, fontWeight: 500,
                fontFamily: 'var(--font-body)', cursor: 'pointer',
              }}
            >
              Continue
            </button>
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
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
