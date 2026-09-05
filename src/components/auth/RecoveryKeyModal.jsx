import { useState } from 'react'

/**
 * Shown ONCE, full-screen, right after encryption is enabled (fresh-connect
 * auto-enable or the Settings enable flow). The recovery key is the ONLY way to
 * add another device or recover the data — there is no password reset and no
 * server-side copy. The user must copy it somewhere safe and tick "I've saved
 * it" before the modal can be dismissed. It can be re-shown later from Settings
 * on any unlocked device (getRecoveryKeyForDisplay), so this isn't the last
 * chance — but it is the moment to capture it.
 *
 * The key sits behind a click-to-reveal blur so it isn't left on screen (or in a
 * screen-share / shoulder-surf) by default.
 */
export default function RecoveryKeyModal({ recoveryKey, onDone }) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (e.g. insecure context) — the user can still select
      // the revealed text manually.
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 11000,
      background: 'var(--bg-primary)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: '24px', padding: '32px', overflowY: 'auto',
    }}>
      <div style={{ textAlign: 'center', maxWidth: '420px' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '34px', fontWeight: 400, letterSpacing: '-0.5px',
          color: 'var(--text-primary)', lineHeight: 1.1, marginBottom: '10px',
        }}>
          Save your recovery key
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.6 }}>
          Encryption is on — everything you save is encrypted before it reaches
          Drive. This key is the only way to unlock your data on another device or
          after clearing this one.
        </p>
      </div>

      <div style={{ width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <button
          onClick={() => setRevealed(true)}
          style={{
            position: 'relative',
            width: '100%', padding: '16px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-mid)',
            borderRadius: '10px',
            color: 'var(--text-primary)',
            fontSize: '15px', letterSpacing: '1.5px', lineHeight: 1.6,
            fontFamily: 'var(--font-mono, monospace)',
            wordBreak: 'break-all', textAlign: 'center',
            cursor: revealed ? 'default' : 'pointer',
            filter: revealed ? 'none' : 'blur(7px)',
            transition: 'filter 0.15s',
            userSelect: revealed ? 'text' : 'none',
          }}
        >
          {recoveryKey}
        </button>
        {!revealed && (
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', textAlign: 'center', marginTop: '-6px' }}>
            Tap to reveal
          </p>
        )}

        <button
          onClick={handleCopy}
          style={{
            width: '100%', padding: '12px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-light)',
            borderRadius: '10px',
            color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 500,
            fontFamily: 'var(--font-body)', cursor: 'pointer',
          }}
        >
          {copied ? 'Copied ✓' : 'Copy to clipboard'}
        </button>
      </div>

      <div style={{
        width: '100%', maxWidth: '420px',
        background: 'rgba(234,179,8,0.08)',
        border: '1px solid rgba(234,179,8,0.25)',
        borderRadius: '10px', padding: '12px 14px',
      }}>
        <p style={{ fontSize: '12px', color: 'var(--yellow-500, #eab308)', lineHeight: 1.6, margin: 0 }}>
          Store it in a password manager now. If you lose it and lose access to all
          your signed-in devices, your data cannot be recovered — not by us, not by
          Google. There is no reset.
        </p>
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', maxWidth: '420px' }}>
        <input
          type="checkbox"
          checked={saved}
          onChange={e => setSaved(e.target.checked)}
          style={{ marginTop: '2px' }}
        />
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          I've saved my recovery key somewhere safe.
        </span>
      </label>

      <button
        onClick={onDone}
        disabled={!saved}
        style={{
          width: '100%', maxWidth: '420px', padding: '12px 20px',
          background: 'var(--accent)',
          border: 'none', borderRadius: '10px',
          color: '#fff', fontSize: '14px', fontWeight: 500,
          fontFamily: 'var(--font-body)',
          cursor: saved ? 'pointer' : 'not-allowed',
          opacity: saved ? 1 : 0.5,
          transition: 'opacity 0.15s',
        }}
      >
        Continue
      </button>
    </div>
  )
}
