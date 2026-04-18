import { useState, useEffect } from 'react'
import useAppStore, { stopSyncEngine, setPollInterval } from '../store/useAppStore'
import { signOut } from '../services/auth'
import { getStorageEstimate, getStoragePersistence, requestStoragePersistence, exportData } from '../services/storage'
import { getMeta, putMeta } from '../services/db'
import { MODE_OFFLINE, MODE_DRIVE, MODE_KEY } from '../lib/constants'
import { GROQ_MODELS, DEFAULT_GROQ_MODEL } from '../services/transcribe'

const sectionHeadStyle = {
  fontSize: '11px', fontWeight: 500, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '12px',
}

const inputStyle = {
  width: '100%', fontSize: '13px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-light)',
  borderRadius: '8px', padding: '8px 12px',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)',
  outline: 'none',
}

const btnPrimaryStyle = {
  fontSize: '13px', fontWeight: 500,
  color: 'var(--accent)', background: 'var(--accent-light)',
  border: 'none', padding: '8px 18px', borderRadius: '8px',
  cursor: 'pointer', fontFamily: 'var(--font-body)',
  transition: 'background 0.15s',
}

const btnSecondaryStyle = {
  fontSize: '13px',
  color: 'var(--text-secondary)',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-light)',
  padding: '8px 18px', borderRadius: '8px',
  cursor: 'pointer', fontFamily: 'var(--font-body)',
  transition: 'background 0.15s',
  textAlign: 'left',
}

function SyncIntervalHelp() {
  const [show, setShow] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setShow(!show)}
        style={{
          width: 18, height: 18, borderRadius: '50%', fontSize: '11px', fontWeight: 600,
          background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)',
          border: '1px solid var(--border-light)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-body)', lineHeight: 1, padding: 0,
        }}
      >?</button>
      {show && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: '6px', width: '260px', padding: '10px 12px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-mid)',
          borderRadius: '8px', fontSize: '12px', color: 'var(--text-secondary)',
          lineHeight: 1.5, zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          <p style={{ marginBottom: '6px' }}>Each poll makes 3 API calls to Google Drive to check for changes.</p>
          <p style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--text-primary)' }}>0.5s</strong> — fastest sync, ~360 req/min. Higher battery usage.</p>
          <p style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--text-primary)' }}>1s</strong> — good balance. ~180 req/min.</p>
          <p style={{ marginBottom: '6px' }}><strong style={{ color: 'var(--text-primary)' }}>2-5s</strong> — light on battery and API quota.</p>
          <p><strong style={{ color: 'var(--text-primary)' }}>10-30s</strong> — minimal usage, slower updates.</p>
        </div>
      )}
    </span>
  )
}

export default function SettingsPage() {
  const config = useAppStore(s => s.config)
  const updateConfig = useAppStore(s => s.updateConfig)
  const setAuthenticated = useAppStore(s => s.setAuthenticated)
  const mode = useAppStore(s => s.mode)
  const userEmail = useAppStore(s => s.userEmail)
  const tasks = useAppStore(s => s.tasks)
  const notes = useAppStore(s => s.notes)
  const currentJournal = useAppStore(s => s.currentJournal)

  const [groqKey, setGroqKey] = useState('')
  const [groqModel, setGroqModel] = useState(DEFAULT_GROQ_MODEL)
  const [saved, setSaved] = useState(false)
  const [storageInfo, setStorageInfo] = useState(null)
  const [persistence, setPersistence] = useState(null)
  const [persistRequesting, setPersistRequesting] = useState(false)

  useEffect(() => {
    setGroqKey(config?.groqApiKey || '')
    setGroqModel(config?.groqModel || DEFAULT_GROQ_MODEL)
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
    await updateConfig({ groqApiKey: groqKey, groqModel })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleSignOut = async () => {
    stopSyncEngine()
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
    await putMeta(MODE_KEY, null)
    setAuthenticated(false)
  }

  const isOffline = mode === MODE_OFFLINE

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <h1 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)' }}>Settings</h1>
      </div>

      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: '520px' }}>

        {/* Mode banner */}
        <div style={{
          borderRadius: '10px', padding: '12px 16px', fontSize: '13px',
          display: 'flex', alignItems: 'flex-start', gap: '12px',
          background: isOffline ? 'rgba(245,158,11,0.08)' : 'var(--accent-light)',
          border: `1px solid ${isOffline ? 'rgba(245,158,11,0.2)' : 'rgba(107,163,214,0.2)'}`,
        }}>
          <span style={{ marginTop: '2px', flexShrink: 0 }}>{isOffline ? '💾' : '☁️'}</span>
          <div>
            <p style={{ fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>
              {isOffline ? 'Offline mode' : 'Google Drive sync'}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {isOffline
                ? 'Data is stored locally in this browser only.'
                : 'Data syncs to your Google Drive automatically.'}
            </p>
          </div>
        </div>

        {/* Sync interval (Drive mode only) */}
        {!isOffline && (
          <section>
            <h2 style={sectionHeadStyle}>Sync</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                Poll interval
              </label>
              <select
                value={config?.syncInterval || 1}
                onChange={e => {
                  const val = Number(e.target.value)
                  updateConfig({ syncInterval: val })
                  setPollInterval(val * 1000)
                }}
                style={{
                  fontSize: '13px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-light)',
                  borderRadius: '8px', padding: '6px 10px',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-body)',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value={0.5}>0.5s</option>
                <option value={1}>1s</option>
                <option value={2}>2s</option>
                <option value={5}>5s</option>
                <option value={10}>10s</option>
                <option value={30}>30s</option>
              </select>
              <SyncIntervalHelp />
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '6px' }}>
              How often to check for changes from other devices.
            </p>
          </section>
        )}

        {/* Offline: storage health */}
        {isOffline && (
          <section>
            <h2 style={sectionHeadStyle}>Local storage</h2>

            {storageInfo && (
              <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '6px' }}>
                  <span>{storageInfo.used} MB used</span>
                  <span>{storageInfo.quota} MB quota</span>
                </div>
                <div style={{ height: 4, background: 'var(--bg-secondary)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', background: 'var(--accent)', borderRadius: '4px',
                    width: `${Math.min(storageInfo.percent, 100)}%`, transition: 'width 0.3s',
                  }} />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                fontSize: '12px', padding: '3px 10px', borderRadius: '20px', fontWeight: 500,
                background: persistence === 'granted' ? 'rgba(16,185,129,0.1)' : persistence === 'denied' ? 'rgba(239,68,68,0.1)' : 'var(--bg-secondary)',
                color: persistence === 'granted' ? 'var(--green-400)' : persistence === 'denied' ? '#FCA5A5' : 'var(--text-tertiary)',
                border: `1px solid ${persistence === 'granted' ? 'rgba(16,185,129,0.2)' : persistence === 'denied' ? 'rgba(239,68,68,0.2)' : 'var(--border-light)'}`,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: persistence === 'granted' ? 'var(--green-500)' : persistence === 'denied' ? '#EF4444' : 'var(--border-mid)',
                }} />
                {persistence === 'granted' ? 'Storage protected' :
                 persistence === 'denied' ? 'Protection denied' :
                 persistence === 'unsupported' ? 'Persistence unsupported' :
                 'Storage not protected'}
              </span>
            </div>

            {persistence !== 'granted' && persistence !== 'unsupported' && (
              <div style={{
                background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                borderRadius: '8px', padding: '12px', marginBottom: '12px',
              }}>
                <p style={{ fontSize: '12px', color: '#FCD34D', marginBottom: '8px', lineHeight: 1.5 }}>
                  Without protection, the browser may clear your data under storage pressure.
                </p>
                <button
                  onClick={handleRequestPersistence}
                  disabled={persistRequesting}
                  style={{
                    fontSize: '12px', fontWeight: 500,
                    color: '#FCD34D', background: 'rgba(245,158,11,0.15)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    padding: '5px 12px', borderRadius: '8px',
                    cursor: persistRequesting ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-body)', opacity: persistRequesting ? 0.5 : 1,
                  }}
                >
                  {persistRequesting ? 'Requesting…' : 'Request persistent storage'}
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button onClick={handleExport} style={btnSecondaryStyle}>
                Export data as JSON
                <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                  Download a backup of all your tasks, notes, and journal
                </span>
              </button>
              <button onClick={handleConnectDrive} style={{ ...btnSecondaryStyle, color: 'var(--accent)', borderColor: 'rgba(107,163,214,0.25)' }}>
                Connect Google Drive
                <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                  Sign in to sync your local data to Drive
                </span>
              </button>
            </div>
          </section>
        )}

        {/* Voice */}
        <section>
          <h2 style={sectionHeadStyle}>Voice & AI</h2>
          <label style={{ display: 'block' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
              Groq API key (for Whisper transcription)
            </span>
            <input
              type="password"
              value={groqKey}
              onChange={e => setGroqKey(e.target.value)}
              placeholder="gsk_…"
              style={inputStyle}
            />
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '6px' }}>
              {isOffline
                ? 'Stored locally in this browser only.'
                : 'Stored in your Google Drive (config.json). Never leaves your account.'}
            </p>
          </label>

          <label style={{ display: 'block', marginTop: '16px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>
              Transcription model
            </span>
            <select
              value={groqModel}
              onChange={e => setGroqModel(e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {GROQ_MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
        </section>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={handleSave} style={btnPrimaryStyle}>
            Save settings
          </button>
          {saved && (
            <span style={{ fontSize: '12px', color: 'var(--green-400)' }}>Saved!</span>
          )}
        </div>

        {/* Account */}
        {!isOffline && (
          <>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border-light)' }} />
            <section>
              <h2 style={sectionHeadStyle}>Account</h2>
              <button
                onClick={handleSignOut}
                style={{
                  fontSize: '13px',
                  color: '#FCA5A5',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  padding: '8px 18px', borderRadius: '8px',
                  cursor: 'pointer', fontFamily: 'var(--font-body)',
                  textAlign: 'left',
                }}
              >
                Sign out{userEmail ? ` (${userEmail})` : ''}
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
