import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import {
  getRecoveryKeyForDisplay, enableEncryption, armEncMigration, disarmEncMigration,
  auditPlaintextRemnants,
} from '../../services/encryption'

const sectionHeadStyle = {
  fontSize: '11px', fontWeight: 500, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '12px',
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

/**
 * Settings → Encryption. Renders off the store's encState:
 *   'unlocked'  → encryption is on; re-show the recovery key, audit for
 *                 unencrypted remnants, re-run the sealing pass on any found.
 *   'plaintext' → encryption is off; the Enable wizard turns it on:
 *                 explainer + backup-deletion consent → arm the migration flag →
 *                 enableEncryption() (publish enc_meta, go 'unlocked') → hand the
 *                 key to the App-level RecoveryKeyModal via pendingRecoveryKey.
 *                 Dismissing that modal starts the one-shot migration (the armed
 *                 flag carries the consent; App.jsx renders the overlay).
 *
 * NOTE the key modal must NOT be rendered from inside the 'plaintext' branch:
 * enableEncryption() flips encState to 'unlocked' mid-flow, this component
 * re-renders into the other branch, and anything mounted here unmounts. The
 * store-level pendingRecoveryKey survives that.
 *   null / 'undetermined' → status not resolved yet (offline / mid-connect).
 */
export default function EncryptionSection() {
  const encState = useAppStore(s => s.encState)
  const [recoveryKey, setRecoveryKey] = useState(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)
  // Audit state: null | 'running' | { checked, plaintext }
  const [audit, setAudit] = useState(null)
  // Enable wizard: null | 'confirm' (the key display + migration take over from
  // the App level once enabling succeeds)
  const [step, setStep] = useState(null)
  const [consentDelete, setConsentDelete] = useState(true)
  const [enabling, setEnabling] = useState(false)
  const [enableError, setEnableError] = useState(null)

  const handleShow = async () => {
    setError(null)
    try {
      setRecoveryKey(await getRecoveryKeyForDisplay())
    } catch {
      setError('Could not read the recovery key on this device.')
    }
  }

  const handleCopy = async () => {
    if (!recoveryKey) return
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — the revealed text can be selected manually */ }
  }

  const handleAudit = async () => {
    setAudit('running')
    try {
      setAudit(await auditPlaintextRemnants())
    } catch (e) {
      setAudit(null)
      setError(`Audit failed: ${e?.message || e}`)
    }
  }

  const handleEnable = async () => {
    if (enabling) return
    setEnabling(true)
    setEnableError(null)
    try {
      // Arm the crash-safe resume flag BEFORE publishing: if the tab dies
      // anywhere after enableEncryption() lands, the next boot picks the
      // migration up. Armed-but-never-enabled is cleaned up by the resume
      // check (status still 'plaintext' → flag dropped).
      await armEncMigration(consentDelete)
      let key
      try {
        key = await enableEncryption()
      } catch (e) {
        await disarmEncMigration().catch(() => {})
        throw e
      }
      // Hand off to the App-level RecoveryKeyModal (this branch is about to
      // re-render away — see the component docstring). Its onDone sees the
      // armed flag and starts the migration.
      setStep(null)
      useAppStore.getState().setPendingRecoveryKey(key)
    } catch (e) {
      // A lost enable race flips encState to 'locked' and App swaps to the
      // UnlockScreen — this section unmounts. Anything else (offline, Drive
      // error) is shown inline and nothing was changed.
      setEnableError(e?.message || String(e))
    }
    setEnabling(false)
  }

  if (encState === 'unlocked') {
    const remnants = audit && audit !== 'running' ? audit.plaintext : null
    return (
      <section>
        <h2 style={sectionHeadStyle}>Encryption</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '14px' }}>
          Your Drive data is encrypted on this device before it's uploaded. Google
          only ever sees ciphertext.
        </p>

        {!recoveryKey ? (
          <button onClick={handleShow} style={btnSecondaryStyle}>
            Show recovery key
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '420px' }}>
            <div style={{
              padding: '12px 14px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-mid)',
              borderRadius: '10px',
              color: 'var(--text-primary)',
              fontSize: '14px', letterSpacing: '1px', lineHeight: 1.6,
              fontFamily: 'var(--font-mono, monospace)',
              wordBreak: 'break-all', textAlign: 'center',
              userSelect: 'text',
            }}>
              {recoveryKey}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={handleCopy} style={btnSecondaryStyle}>
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              <button onClick={() => setRecoveryKey(null)} style={btnSecondaryStyle}>
                Hide
              </button>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--yellow-500, #eab308)', lineHeight: 1.6 }}>
              Anyone with this key can read your data. Keep it in a password manager
              — if it's lost along with all your signed-in devices, the data cannot
              be recovered.
            </p>
          </div>
        )}

        <div style={{ marginTop: '12px' }}>
          <button onClick={handleAudit} disabled={audit === 'running'} style={{ ...btnSecondaryStyle, ...(audit === 'running' ? { opacity: 0.6, cursor: 'wait' } : {}) }}>
            {audit === 'running' ? 'Checking…' : 'Check for unencrypted files'}
          </button>
          {remnants && remnants.length === 0 && (
            <p style={{ fontSize: '12px', color: 'var(--green-400, #4ade80)', marginTop: '8px' }}>
              All {audit.checked} files on Drive are encrypted ✓
            </p>
          )}
          {remnants && remnants.length > 0 && (
            <div style={{ marginTop: '8px', maxWidth: '420px' }}>
              <p style={{ fontSize: '12px', color: 'var(--yellow-500, #eab308)', lineHeight: 1.5 }}>
                {remnants.length} unencrypted file{remnants.length === 1 ? '' : 's'} found
                (usually from a device that synced before it locked):
              </p>
              <ul style={{ fontSize: '11px', color: 'var(--text-tertiary)', margin: '6px 0 8px', paddingLeft: '18px', lineHeight: 1.5 }}>
                {remnants.slice(0, 6).map(r => (
                  <li key={r.fileId}>{r.bucket}/{r.name}{r.err ? ' (unreadable)' : ''}</li>
                ))}
                {remnants.length > 6 && <li>…and {remnants.length - 6} more</li>}
              </ul>
              <button
                onClick={() => { setAudit(null); useAppStore.getState().runEncMigration({ consentDeleteBackups: false }) }}
                style={btnSecondaryStyle}
              >
                Encrypt them now
              </button>
            </div>
          )}
        </div>

        {error && (
          <p style={{ fontSize: '12px', color: '#FCA5A5', marginTop: '8px' }}>{error}</p>
        )}
      </section>
    )
  }

  if (encState === 'plaintext') {
    return (
      <section>
        <h2 style={sectionHeadStyle}>Encryption</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '14px' }}>
          Your Drive data is currently stored unencrypted. Turning on encryption
          scrambles everything client-side so only your devices can read it.
        </p>
        <button onClick={() => { setEnableError(null); setStep('confirm') }} style={btnSecondaryStyle}>
          Enable encryption…
        </button>

        {step === 'confirm' && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 11000,
            background: 'var(--bg-primary)',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: '20px', padding: '32px', overflowY: 'auto',
          }}>
            <div style={{ textAlign: 'center', maxWidth: '440px' }}>
              <h1 style={{
                fontFamily: 'var(--font-display)',
                fontSize: '34px', fontWeight: 400, letterSpacing: '-0.5px',
                color: 'var(--text-primary)', lineHeight: 1.1, marginBottom: '10px',
              }}>
                Turn on encryption
              </h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.6, textAlign: 'left' }}>
                Everything you save will be encrypted on this device before it
                reaches Google Drive, and everything already there gets encrypted
                in a one-time pass (a few minutes, depending on how much you have).
              </p>
            </div>

            <div style={{
              width: '100%', maxWidth: '440px',
              background: 'rgba(234,179,8,0.08)',
              border: '1px solid rgba(234,179,8,0.25)',
              borderRadius: '10px', padding: '12px 14px',
            }}>
              <p style={{ fontSize: '12px', color: 'var(--yellow-500, #eab308)', lineHeight: 1.6, margin: 0 }}>
                Do this on your most reliable device, and close or pause the app on
                your other devices first. They'll lock as soon as they notice, and
                will need the recovery key (shown next) to sync again.
              </p>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', maxWidth: '440px' }}>
              <input
                type="checkbox"
                checked={consentDelete}
                onChange={e => setConsentDelete(e.target.checked)}
                style={{ marginTop: '2px' }}
              />
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Also delete the old pre-migration backup files from Drive
                (recommended — they're unencrypted copies of data the app no longer
                reads; unticking keeps them, encrypted).
              </span>
            </label>

            {enableError && (
              <p style={{ fontSize: '12px', color: '#FCA5A5', maxWidth: '440px', lineHeight: 1.5 }}>
                Couldn't enable encryption: {enableError}
              </p>
            )}

            <div style={{ display: 'flex', gap: '12px', width: '100%', maxWidth: '440px' }}>
              <button
                onClick={() => setStep(null)}
                disabled={enabling}
                style={{ ...btnSecondaryStyle, flex: 1, textAlign: 'center' }}
              >
                Cancel
              </button>
              <button
                onClick={handleEnable}
                disabled={enabling}
                style={{
                  flex: 2, padding: '10px 20px',
                  background: 'var(--accent)', border: 'none', borderRadius: '8px',
                  color: '#fff', fontSize: '14px', fontWeight: 500,
                  fontFamily: 'var(--font-body)',
                  cursor: enabling ? 'wait' : 'pointer',
                  opacity: enabling ? 0.6 : 1,
                }}
              >
                {enabling ? 'Enabling…' : 'Enable encryption'}
              </button>
            </div>
          </div>
        )}

      </section>
    )
  }

  // null / 'undetermined' — status not resolved (offline, or mid-connect).
  return null
}
