/** Persistent storage for the in-browser backend.
 *
 * GitHub Pages serves files only, so a deployed console has no Python service
 * and no server-side database. Everything the API would have persisted lives
 * here instead: one record per analysed session, the original blob of each
 * upload, and the engine configuration. IndexedDB is used because a session is
 * far larger than the ~5 MB localStorage budget; a Map keeps the same API
 * working in a test environment where IndexedDB does not exist.
 */
import type { GroundTruthLabel, Level } from "../types";

export interface StoredObservation {
  /** 0-based index within the analysed frame stream. */
  frame: number;
  /** Seconds from the start of the analysed stream. */
  ts: number;
  trackId: number;
  level: Level;
  /** Fused 0–1 score the verdict was taken from. */
  score: number;
  /** Rule channel: deviation magnitude on 0–1. */
  rule: number;
  /** ML channel; null when the local engine has no model to run. */
  ml: number | null;
  /** Scene channel: deviation from the learned baseline, 0–1. */
  scene: number | null;
  /** Measured speed in source-video pixels per second. */
  speed: number | null;
  direction: number | null;
  areaPct: number;
  colour: string;
  box: [number, number, number, number];
  centroid: [number, number];
  /** Track-confirmation count at this frame (frames matched so far). */
  seen: number;
}

export interface StoredPreview {
  frame: number;
  tsS: number;
  /** JPEG data URL with boxes and IDs drawn on. */
  annotated: string;
  /** JPEG data URL of the untouched frame. */
  original: string;
}

export interface StoredSession {
  id: string;
  createdTs: string;
  startedTs: string;
  endedTs: string;
  source: {
    label: string;
    kind: "upload" | "sample" | "live";
    synthetic: boolean;
    bytes: number | null;
    fps: number | null;
    width: number | null;
    height: number | null;
    durationS: number | null;
  };
  processing: {
    frames: number;
    width: number | null;
    height: number | null;
    fps: number | null;
    wallS: number;
    processFps: number;
    maxFrames: number | null;
    videoDurationS: number | null;
  };
  observations: StoredObservation[];
  previews: StoredPreview[];
  /** Crops of irregular objects, keyed `${frame}:${trackId}`. */
  crops: Record<string, string>;
  labels: GroundTruthLabel[];
  /** Which engine produced the numbers: always the in-browser one. */
  engine: string;
}

export interface StoredUpload {
  id: string;
  name: string;
  bytes: number;
  type: string | null;
  createdTs: string;
  blob: Blob;
  probe: {
    fps: number | null;
    frames: number | null;
    width: number | null;
    height: number | null;
    durationS: number | null;
  };
}

const DB_NAME = "neural-command";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const UPLOADS = "uploads";
const META = "meta";

interface MetaRecord {
  key: string;
  value: unknown;
}

const memory = {
  sessions: new Map<string, StoredSession>(),
  uploads: new Map<string, StoredUpload>(),
  meta: new Map<string, unknown>(),
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(UPLOADS)) db.createObjectStore(UPLOADS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(store, mode);
    } catch {
      resolve(null);
      return;
    }
    const request = run(transaction.objectStore(store));
    if (!request) {
      resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => resolve(null);
  });
}

export async function putSession(session: StoredSession): Promise<void> {
  memory.sessions.set(session.id, session);
  await withStore(SESSIONS, "readwrite", (store) => store.put(session));
}

export async function getSession(id: string): Promise<StoredSession | null> {
  const cached = memory.sessions.get(id);
  if (cached) return cached;
  const record = await withStore<StoredSession>(SESSIONS, "readonly", (store) => store.get(id));
  if (record) memory.sessions.set(record.id, record);
  return record ?? null;
}

/** All sessions, newest first. */
export async function listSessions(): Promise<StoredSession[]> {
  const rows =
    (await withStore<StoredSession[]>(SESSIONS, "readonly", (store) => store.getAll())) ?? [];
  for (const row of rows) memory.sessions.set(row.id, row);
  return [...rows, ...[...memory.sessions.values()].filter((row) => !rows.some((r) => r.id === row.id))]
    .sort((a, b) => b.createdTs.localeCompare(a.createdTs));
}

export async function putUpload(upload: StoredUpload): Promise<void> {
  memory.uploads.set(upload.id, upload);
  await withStore(UPLOADS, "readwrite", (store) => store.put(upload));
}

export async function getUpload(id: string): Promise<StoredUpload | null> {
  const cached = memory.uploads.get(id);
  if (cached) return cached;
  const record = await withStore<StoredUpload>(UPLOADS, "readonly", (store) => store.get(id));
  if (record) memory.uploads.set(record.id, record);
  return record ?? null;
}

export async function getMeta<T>(key: string): Promise<T | null> {
  if (memory.meta.has(key)) return memory.meta.get(key) as T;
  const record = await withStore<MetaRecord>(META, "readonly", (store) => store.get(key));
  if (!record) return null;
  memory.meta.set(key, record.value);
  return record.value as T;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  memory.meta.set(key, value);
  await withStore(META, "readwrite", (store) => store.put({ key, value }));
}

/** Erase every session, upload and stored setting. Irreversible. */
export async function clearAll(): Promise<{ sessions: number; uploads: number }> {
  const sessions = memory.sessions.size;
  const uploads = memory.uploads.size;
  memory.sessions.clear();
  memory.uploads.clear();
  memory.meta.clear();
  await withStore(SESSIONS, "readwrite", (store) => store.clear());
  await withStore(UPLOADS, "readwrite", (store) => store.clear());
  await withStore(META, "readwrite", (store) => store.clear());
  return { sessions, uploads };
}
