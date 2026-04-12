export function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/yajna/sw.js')
        .then((reg) => console.log('SW registered', reg.scope))
        .catch((e) => console.error('SW registration failed', e))
    })
  }
}
