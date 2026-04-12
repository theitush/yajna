export default function LoginScreen({ onLogin, onOffline, loading }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">yajna</h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          yet another journaling and notes app
        </p>
      </div>

      <div className="flex flex-col items-center gap-3 w-full max-w-xs">
        <button
          onClick={onLogin}
          disabled={loading}
          className="flex items-center gap-3 w-full justify-center px-6 py-3 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl shadow-sm hover:shadow-md transition-shadow text-gray-700 dark:text-gray-200 font-medium disabled:opacity-50"
        >
          <GoogleIcon />
          {loading ? 'Connecting…' : 'Sign in with Google'}
        </button>

        <div className="flex items-center gap-3 w-full">
          <hr className="flex-1 border-gray-200 dark:border-gray-700" />
          <span className="text-xs text-gray-400">or</span>
          <hr className="flex-1 border-gray-200 dark:border-gray-700" />
        </div>

        <button
          onClick={onOffline}
          disabled={loading}
          className="flex items-center gap-3 w-full justify-center px-6 py-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-600 dark:text-gray-300 font-medium disabled:opacity-50"
        >
          <OfflineIcon />
          Continue offline
        </button>
      </div>

      <div className="text-center max-w-xs space-y-2">
        <p className="text-xs text-gray-400">
          <span className="font-medium text-gray-500 dark:text-gray-400">Google sign-in</span>
          {' '}— syncs to your Drive. Access from any device.
        </p>
        <p className="text-xs text-gray-400">
          <span className="font-medium text-gray-500 dark:text-gray-400">Offline mode</span>
          {' '}— local only. Data lives in this browser. You can connect Drive later.
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
