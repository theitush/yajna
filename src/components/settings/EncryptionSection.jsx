import { useState } from 'react'
import useAppStore from '../../store/useAppStore'
import { getRecoveryKeyForDisplay } from '../../services/encryption'

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
 *   'unlocked'  → encryption is on; re-show the recovery key on demand.
 *   'plaintext' → encryption is off; offer to enable it.
 *   null / 'undetermined' → status not resolved yet (offline / mid-connect).
 *
 * Stage 3 scope: the "Show recovery key" path is fully live. Enabling an account
 * that already holds data requires the one-shot migration of existing files,
 * which ships in the next update — so the enable button is present but disabled
 * with a caption. A brand-new Drive is auto-encrypted at first connect, so there
 * is no plaintext-with-data enable path to wire here yet.
 */
export default function EncryptionSection() {
  const encState = useAppStore(s => s.encState)
  const [recoveryKey, setRecoveryKey] = useState(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)

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

  if (encState === 'unlocked') {
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
        <button disabled style={{ ...btnSecondaryStyle, cursor: 'not-allowed', opacity: 0.55 }}>
          Enable encryption
        </button>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '8px', lineHeight: 1.5 }}>
          Encrypting an account that already has data (a one-time pass over your
          existing files) ships in the next update.
        </p>
      </section>
    )
  }

  // null / 'undetermined' — status not resolved (offline, or mid-connect).
  return null
}
