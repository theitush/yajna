import { useState, useEffect } from 'react'
import useAppStore from '../store/useAppStore'
import { signOut } from '../services/auth'

export default function SettingsPage() {
  const config = useAppStore(s => s.config)
  const updateConfig = useAppStore(s => s.updateConfig)
  const setAuthenticated = useAppStore(s => s.setAuthenticated)
  const [groqKey, setGroqKey] = useState('')
  const [template, setTemplate] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setGroqKey(config?.groqApiKey || '')
    setTemplate(config?.journalTemplate || '')
  }, [config])

  const handleSave = async () => {
    await updateConfig({ groqApiKey: groqKey, journalTemplate: template })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleSignOut = () => {
    signOut()
    setAuthenticated(false)
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">Settings</h1>
      </div>

      <div className="p-4 space-y-6 max-w-lg">
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
              Your key is stored only in your Google Drive (config.json). It never leaves your account.
            </p>
          </label>
        </section>

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
      </div>
    </div>
  )
}
