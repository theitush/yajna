import { useState } from 'react'
import { unlockWithRecoveryKey } from '../../services/encryption'
import { RecoveryKeyError } from '../../services/cryptoBox'

/**
 * Full-screen gate shown when this device finds an encrypted Drive but has no
 * key (encState === 'locked'). The user pastes/types their recovery key; on
 * success we reload, reusing the whole proven warm-boot path (initEncryption
 * loads the now-persisted key → 'unlocked' → normal app) instead of a bespoke
 * continuation. No local edits happen while locked — reads can't pull, so an
 * edit would be an edit-over-unmerged-state; it's a once-per-device, one-minute
 * state.
 */
export default function UnlockScreen({ onSignOut }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const handleUnlock = async () => {
    if (busy || !value.trim()) return
    setBusy(true)
    setError(null)
    try {
      await unlockWithRecoveryKey(value)
      // Persisted + status flipped — reload into the normal boot path.
      window.location.reload()
    } catch (e) {
      if (e instanceof RecoveryKeyError) {
        // parseRecoveryKey caught a malformed key offline. checksum = a typo in
        // an otherwise complete key; length/char = it isn't a full key yet.
        setError(e.code === 'checksum'
          ? 'That key has a typo — double-check each character.'
          : 'That doesn’t look like a complete recovery key.')
      } else {
        // Well-formed key, but keyCheck (or config.bin) GCM-auth failed: it's a
        // valid recovery key, just not this account's.
        setError('That key is valid, but not for this account’s data.')
      }
      setBusy(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleUnlock() }
  }

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '28px', padding: '32px',
      background: 'var(--bg-primary)',
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '40px', fontWeight: 400, letterSpacing: '-1px',
          color: 'var(--text-primary)', lineHeight: 1, marginBottom: '8px',
        }}>
          Locked
        </h1>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', letterSpacing: '0.3px', lineHeight: 1.5, maxWidth: '300px' }}>
          This device needs your recovery key to read the encrypted data on your Drive.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '340px' }}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
          style={{
            width: '100%', padding: '12px 14px',
            background: 'var(--bg-secondary)',
            border: `1px solid ${error ? '#EA4335' : 'var(--border-mid)'}`,
            borderRadius: '10px',
            color: 'var(--text-primary)',
            fontSize: '14px', letterSpacing: '1px',
            fontFamily: 'var(--font-mono, monospace)',
            textAlign: 'center',
            outline: 'none',
          }}
        />

        {error && (
          <p style={{ fontSize: '12px', color: '#FCA5A5', lineHeight: 1.5, textAlign: 'center' }}>
            {error}
          </p>
        )}

        <button
          onClick={handleUnlock}
          disabled={busy || !value.trim()}
          style={{
            width: '100%', padding: '12px 20px',
            background: 'var(--accent)',
            border: 'none', borderRadius: '10px',
            color: '#fff', fontSize: '14px', fontWeight: 500,
            fontFamily: 'var(--font-body)',
            cursor: (busy || !value.trim()) ? 'not-allowed' : 'pointer',
            opacity: (busy || !value.trim()) ? 0.5 : 1,
            transition: 'opacity 0.15s',
          }}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>

      <div style={{ textAlign: 'center', maxWidth: '300px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          The recovery key was shown once when you enabled encryption. You can re-show it from Settings on any unlocked device.
        </p>
        <button
          onClick={onSignOut}
          disabled={busy}
          style={{
            background: 'none', border: 'none',
            color: 'var(--text-tertiary)', fontSize: '12px',
            textDecoration: 'underline', cursor: busy ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-body)',
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
