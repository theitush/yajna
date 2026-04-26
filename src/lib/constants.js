export const DRIVE_FOLDER_NAME = 'yajna'
export const DRIVE_MIME_FOLDER = 'application/vnd.google-apps.folder'

export const TASK_STATUS = {
  ACTIVE: 'active',
  DONE: 'done',
  DISMISSED: 'dismissed',
  BACKLOG: 'backlog',
  SCHEDULED: 'scheduled',
}

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '453487156075-v3drv8hq708jmkbntgubs4tq31fd3qm9.apps.googleusercontent.com'
export const AUTH_WORKER_URL = import.meta.env.VITE_AUTH_WORKER_URL || 'https://yajna-auth.yajna-auth.workers.dev'
export const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email'

export const DB_NAME = 'yajna-db'
export const DB_VERSION = 2
export const STORE_TASKS = 'tasks'
export const STORE_NOTES = 'notes'
export const STORE_JOURNALS = 'journals'
export const STORE_CONFIG = 'config'
export const STORE_META = 'meta'
export const STORE_AUDIO = 'audio'

export const MODE_DRIVE = 'drive'
export const MODE_OFFLINE = 'offline'
export const MODE_KEY = 'yajna_mode'
