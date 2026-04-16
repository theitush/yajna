import { DRIVE_FOLDER_NAME, DRIVE_MIME_FOLDER } from '../lib/constants'
import { getMeta, putMeta } from './db'

const FOLDER_ID_KEY = 'drive_folder_id'
const FILES_KEY = 'drive_files'
const API_TIMEOUT_MS = 15_000

/** Wrap a promise with a timeout so Drive API calls can't hang forever. */
function withTimeout(promise, ms = API_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Drive API call timed out')), ms)
    ),
  ])
}

/**
 * Find or create the app root folder in Drive
 */
export async function getOrCreateAppFolder() {
  const cached = await getMeta(FOLDER_ID_KEY)
  if (cached) return cached

  // Search for existing folder
  const res = await withTimeout(window.gapi.client.drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='${DRIVE_MIME_FOLDER}' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  }))

  if (res.result.files.length > 0) {
    const id = res.result.files[0].id
    await putMeta(FOLDER_ID_KEY, id)
    return id
  }

  // Create folder
  const created = await withTimeout(window.gapi.client.drive.files.create({
    resource: {
      name: DRIVE_FOLDER_NAME,
      mimeType: DRIVE_MIME_FOLDER,
    },
    fields: 'id',
  }))
  const id = created.result.id
  await putMeta(FOLDER_ID_KEY, id)
  return id
}

/**
 * Get or create a subfolder inside the app folder
 */
export async function getOrCreateSubfolder(parentId, name) {
  const res = await withTimeout(window.gapi.client.drive.files.list({
    q: `name='${name}' and mimeType='${DRIVE_MIME_FOLDER}' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id)',
  }))
  if (res.result.files.length > 0) return res.result.files[0].id

  const created = await withTimeout(window.gapi.client.drive.files.create({
    resource: {
      name,
      mimeType: DRIVE_MIME_FOLDER,
      parents: [parentId],
    },
    fields: 'id',
  }))
  return created.result.id
}

/**
 * Find a file by name in a folder
 */
export async function findFile(parentId, name) {
  const res = await withTimeout(window.gapi.client.drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id)',
  }))
  return res.result.files[0]?.id || null
}

/**
 * Read a JSON file from Drive
 */
export async function readJsonFile(fileId) {
  const res = await withTimeout(window.gapi.client.drive.files.get({
    fileId,
    alt: 'media',
  }))
  if (typeof res.body === 'string') {
    return JSON.parse(res.body)
  }
  return res.result
}

/**
 * Create or update a JSON file in Drive
 */
export async function writeJsonFile(parentId, name, data, existingFileId = null) {
  const content = JSON.stringify(data, null, 2)
  const blob = new Blob([content], { type: 'application/json' })

  const metadata = {
    name,
    mimeType: 'application/json',
    ...(existingFileId ? {} : { parents: [parentId] }),
  }

  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('media', blob)

  const token = window.gapi.client.getToken()?.access_token

  if (existingFileId) {
    await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }
    )
    return existingFileId
  } else {
    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }
    )
    const json = await res.json()
    return json.id
  }
}

/**
 * Upload an audio blob to Drive
 */
export async function uploadAudioFile(parentId, name, blob) {
  const token = window.gapi.client.getToken()?.access_token
  const metadata = {
    name,
    mimeType: blob.type || 'audio/webm',
    parents: [parentId],
  }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('media', blob)

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }
  )
  return res.json()
}

/**
 * Initialize the full folder structure and return all file ids
 */
export async function initDriveStructure() {
  const rootId = await getOrCreateAppFolder()
  const journalsFolderId = await getOrCreateSubfolder(rootId, 'journals')

  const ensureFile = async (name, defaultData) => {
    let fileId = await findFile(rootId, name)
    if (!fileId) {
      fileId = await writeJsonFile(rootId, name, defaultData)
    }
    return fileId
  }

  const [tasksFileId, notesFileId, configFileId] = await Promise.all([
    ensureFile('tasks.json', []),
    ensureFile('notes.json', []),
    ensureFile('config.json', {}),
  ])

  await putMeta(FILES_KEY, { rootId, journalsFolderId, tasksFileId, notesFileId, configFileId })
  return { rootId, journalsFolderId, tasksFileId, notesFileId, configFileId }
}

export async function getDriveFileIds() {
  return getMeta(FILES_KEY)
}
