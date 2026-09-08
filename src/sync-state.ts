import type { SyncEntry } from "./sync-reconcile";

const KEY = "nas-vault-sync.v1.base";
const PENDING_UPLOADS_KEY = "nas-vault-sync.v1.pending-uploads";
export interface SyncState { entries: SyncEntry[]; revision: string; updatedAt: string }
export interface PendingUpload { uploadId: string; path: string; sha256: string; size: number; ifMatch?: string; ifNoneMatch?: true }

/** localStorage is device-local in Obsidian and intentionally outside vault files. */
export function loadSyncState(): SyncState | undefined {
  try { const raw = window.localStorage.getItem(KEY); return raw ? JSON.parse(raw) as SyncState : undefined; } catch { return undefined; }
}
export function saveSyncState(entries: readonly SyncEntry[], revision: string): void {
  window.localStorage.setItem(KEY, JSON.stringify({ entries, revision, updatedAt: new Date().toISOString() }));
}
export function clearSyncState(): void { try { window.localStorage.removeItem(KEY); } catch { /* no local storage */ } }

function pendingUploads(): Record<string, PendingUpload> {
  try {
    const value = JSON.parse(window.localStorage.getItem(PENDING_UPLOADS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function loadPendingUpload(path: string): PendingUpload | undefined {
  const value = pendingUploads()[path];
  return value && typeof value.uploadId === "string" && typeof value.sha256 === "string" && Number.isInteger(value.size) ? value : undefined;
}
export function savePendingUpload(value: PendingUpload): void {
  const uploads = pendingUploads(); uploads[value.path] = value;
  window.localStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(uploads));
}
export function clearPendingUpload(path: string): void {
  const uploads = pendingUploads(); delete uploads[path];
  try { window.localStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(uploads)); } catch { /* no local storage */ }
}
