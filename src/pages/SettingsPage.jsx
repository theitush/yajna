import { useState, useEffect } from 'react'
import useAppStore from '../store/useAppStore'
import { signOut } from '../services/auth'
import { getStorageEstimate, getStoragePersistence, requestStoragePersistence, exportData } from '../services/storage'
import { getMeta, putMeta } from '../services/db'
import { MODE_OFFLINE, MODE_DRIVE, MODE_KEY } from '../lib/constants'

export default function SettingsPage() {
  const config = useAppStore(s => s.config)
  const updateConfig = useAppStore(s => s.updateConfig)
  const setAuthenticated = useAppStore(s => s.setAuthenticated)
  const mode = useAppStore(s => s.mode)
  const tasks = useAppStore(s => s.tasks)
  const notes = useAppStore(s => s.notes)
  const currentJournal = useAppStore(s => s.currentJournal)

  const [groqKey, setGroqKey] = useState('')
  const [template, setTemplate] = useState('')
  const [saved, setSaved] = useState(false)
  const [storageInfo, setStorageInfo] = useState(null)
  const [persistence, setPersistence] = useState(null)
  const [persistRequesting, setPersistRequesting] = useState(false)

  useEffect(() => {
    setGroqKey(config?.groqApiKey || '')
    setTemplate(config?.journalTemplate || '')
  }, [config])

  useEffect(() => {
    async function loadStorage() {
      const [estimate, persist] = await Promise.all([
        getStorageEstimate(),
        getStoragePersistence(),
      ])
      setStorageInfo(estimate)
      setPersistence(persist)
    }
    loadStorage()
  }, [])

  const handleSave = async () => {
    await updateConfig({ groqApiKey: groqKey, journalTemplate: template })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleSignOut = async () => {
    signOut()
    await putMeta(MODE_KEY, null)
    setAuthenticated(false)
  }

  const handleRequestPersistence = async () => {
    setPersistRequesting(true)
    const result = await requestStoragePersistence()
    setPersistence(result)
    setPersistRequesting(false)
  }

  const handleExport = () => {
    const journals = currentJournal ? [currentJournal] : []
    exportData(tasks, notes, journals)
  }

  const handleConnectDrive = async () => {
    // Clear offline mode — next reload will show login screen
    await putMeta(MODE_KEY, null)
    setAuthenticated(false)
  }

  const isOffline = mode === MODE_OFFLINE

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">Settings</h1>
      </div>

      <div className="p-4 space-y-6 max-w-lg">

        {/* Mode banner */}
        <div className={`rounded-xl px-4 py-3 text-sm flex items-start gap-3 ${
          isOffline
            ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
            : 'bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800'
        }`}>
          <span className="mt-0.5 shrink-0">{isOffline ? '💾' : '☁️'}</span>
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">
              {isOffline ? 'Offline mode' : 'Google Drive sync'}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {isOffline
                ? 'Data is stored locally in this browser only.'
                : 'Data syncs to your Google Drive automatically.'}
            </p>
          </div>
        </div>

        {/* Offline: storage health */}
        {isOffline && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Local storage</h2>

            {storageInfo && (
              <div className="mb-3">
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>{storageInfo.used} MB used</span>
                  <span>{storageInfo.quota} MB quota</span>
                </div>
                <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all"
                    style={{ width: `${Math.min(storageInfo.percent, 100)}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 mb-3">
              <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${
                persistence === 'granted'
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                  : persistence === 'denied'
                  ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  persistence === 'granted' ? 'bg-green-500' :
                  persistence === 'denied' ? 'bg-red-500' : 'bg-gray-400'
                }`} />
                {persistence === 'granted' ? 'Storage protected' :
                 persistence === 'denied' ? 'Protection denied' :
                 persistence === 'unsupported' ? 'Persistence unsupported' :
                 'Storage not protected'}
              </span>
            </div>

            {persistence !== 'granted' && persistence !== 'unsupported' && (
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mb-3">
                <p className="text-xs text-amber-800 dark:text-amber-300 mb-2">
                  Without protection, the browser may clear your data under storage pressure. Request persistent storage to prevent this.
                </p>
                <button
                  onClick={handleRequestPersistence}
                  disabled={persistRequesting}
                  className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                >
                  {persistRequesting ? 'Requesting…' : 'Request persistent storage'}
                </button>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <button
                onClick={handleExport}
                className="text-sm px-4 py-2 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
              >
                Export data as JSON
                <span className="block text-xs text-gray-400 mt-0.5">Download a backup of all your tasks, notes, and journal</span>
              </button>
              <button
                onClick={handleConnectDrive}
                className="text-sm px-4 py-2 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 rounded-lg hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors text-left"
              >
                Connect Google Drive
                <span className="block text-xs text-gray-400 mt-0.5">Sign in to sync your local data to Drive</span>
              </button>
            </div>
          </section>
        )}

        {/* Voice */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Voice & AI</h2>
          <label className="block">
            <span className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">
              Groq API key (for Whisper transcription)
            </span>
            <input
              type="password"
              value={groqKey}
              onChange={e => setGroqKey(e.target.value)}
              placeholder="gsk_…"
              className="w-full text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:ring-2 focus:ring-violet-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              {isOffline
                ? 'Stored locally in this browser only.'
                : 'Stored in your Google Drive (config.json). Never leaves your account.'}
            </p>
          </label>
        </section>

        {/* Journal template */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Journal template</h2>
          <textarea
            value={template}
            onChange={e => setTemplate(e.target.value)}
            rows={8}
            placeholder={`## Morning\n\n## Working on\n\n## Thinking about\n`}
            className="w-full text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:ring-2 focus:ring-violet-500 font-mono resize-none"
          />
          <p className="text-xs text-gray-400 mt-1">
            Used for new daily entries. Markdown headings become sections.
          </p>
        </section>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="text-sm px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors"
          >
            Save settings
          </button>
          {saved && (
            <span className="text-xs text-green-600 dark:text-green-400">Saved!</span>
          )}
        </div>

        {/* Account (Drive mode only) */}
        {!isOffline && (
          <>
            <hr className="border-gray-200 dark:border-gray-700" />
            <section>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Account</h2>
              <button
                onClick={handleSignOut}
                className="text-sm px-4 py-2 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                Sign out
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
