export default function LoginScreen({ onLogin, onOffline, loading }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: '32px', padding: '32px',
      background: 'var(--bg-primary)',
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '48px', fontWeight: 400,
          letterSpacing: '-1px',
          color: 'var(--text-primary)',
          lineHeight: 1, marginBottom: '8px',
        }}>
          Yajna
        </h1>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px', letterSpacing: '0.3px' }}>
          journal · notes · todos
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '100%', maxWidth: '280px' }}>
        <button
          onClick={onLogin}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            width: '100%', justifyContent: 'center',
            padding: '12px 20px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-mid)',
            borderRadius: '10px',
            color: 'var(--text-primary)',
            fontSize: '14px', fontWeight: 500,
            fontFamily: 'var(--font-body)',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.5 : 1,
            transition: 'background 0.15s',
          }}
        >
          <GoogleIcon />
          {loading ? 'Connecting…' : 'Sign in with Google'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--border-light)' }} />
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>or</span>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid var(--border-light)' }} />
        </div>

        <button
          onClick={onOffline}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            width: '100%', justifyContent: 'center',
            padding: '12px 20px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-light)',
            borderRadius: '10px',
            color: 'var(--text-secondary)',
            fontSize: '14px', fontWeight: 500,
            fontFamily: 'var(--font-body)',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.5 : 1,
            transition: 'background 0.15s',
          }}
        >
          <OfflineIcon />
          Continue offline
        </button>
      </div>

      <div style={{ textAlign: 'center', maxWidth: '280px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Google sign-in</span> — syncs to your Drive. Access from any device.
        </p>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Offline mode</span> — local only. Data lives in this browser.
        </p>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/>
    </svg>
  )
}

function OfflineIcon() {
  return (
    <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} aria-hidden="true">
      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/>
      <path d="M12 8v4l3 3"/>
    </svg>
  )
}
