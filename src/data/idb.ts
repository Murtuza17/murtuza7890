/**
 * Minimal IndexedDB wrapper. No dependency — a wrapper library is a few more
 * kilobytes over a 2G link for about eighty lines of code.
 *
 * Everything the app owes the server lives here, so it must survive the browser
 * being killed mid-drain. localStorage would not: it is synchronous, size-capped
 * and string-only.
 */

const DB_NAME = 'vetswap'
const DB_VERSION = 1

export const STORE_OUTBOX = 'outbox'
export const STORE_CACHE = 'cache'
export const STORE_META = 'meta'

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        db.createObjectStore(STORE_OUTBOX, { keyPath: 'clientId' })
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE)
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'))
  })
  return dbPromise
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = fn(tx.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'))
      }),
  )
}

export const idbGet = <T>(store: string, key: IDBValidKey) =>
  run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)

export const idbGetAll = <T>(store: string) =>
  run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)

export const idbPut = (store: string, value: unknown, key?: IDBValidKey) =>
  run<IDBValidKey>(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)))

export const idbDelete = (store: string, key: IDBValidKey) =>
  run<undefined>(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>)

/**
 * Stable per-device id. Part of the audit trail: two phones at the same clinic
 * are two actors, and a dispute needs to say which one recorded what.
 */
export async function deviceId(): Promise<string> {
  const existing = await idbGet<string>(STORE_META, 'deviceId')
  if (existing) return existing
  const id = crypto.randomUUID()
  await idbPut(STORE_META, id, 'deviceId')
  return id
}
