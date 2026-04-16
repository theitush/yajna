import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// When loaded inside the silent-refresh iframe, don't render the app.
// The parent reads iframe.contentWindow.location to extract the token/error.
if (window.self !== window.top) {
  // Do nothing — the parent's iframe load handler will read our URL.
} else {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
