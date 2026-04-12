/**
 * Persistent storage permission management.
 * Returns 'granted' | 'denied' | 'prompt' | 'unsupported'
 */
export async function getStoragePersistence() {
  if (!navigator.storage?.persisted) return 'unsupported'
  const persisted = await navigator.storage.persisted()
  return persisted ? 'granted' : 'prompt'
}

export async function requestStoragePersistence() {
  if (!navigator.storage?.persist) return 'unsupported'
  const granted = await navigator.storage.persist()
  return granted ? 'granted' : 'denied'
}

/**
 * Returns estimated storage usage as { used, quota, percent }
 * Values in MB.
 */
export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null
  const { usage, quota } = await navigator.storage.estimate()
  return {
    used: Math.round((usage || 0) / 1024 / 1024 * 10) / 10,
    quota: Math.round((quota || 0) / 1024 / 1024),
    percent: quota ? Math.round((usage / quota) * 100) : 0,
  }
}

/**
 * Export all local data as a JSON blob for download.
 */
export async function exportData(tasks, notes, journals) {
  const data = {
    exportedAt: new Date().toISOString(),
    version: 1,
    tasks,
    notes,
    journals,
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `yajna-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}
