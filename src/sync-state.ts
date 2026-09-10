import type { SyncEntry } from "./sync-reconcile";

const KEY = "nas-vault-sync.v1.base";
const PENDING_UPLOADS_KEY = "nas-vault-sync.v1.pending-uploads";
const ISSUES_KEY = "nas-vault-sync.v1.issues";
export interface SyncState { entries: SyncEntry[]; revision: string; updatedAt: string }
export interface PendingUpload { uploadId: string; path: string; sha256: string; size: number; ifMatch?: string; ifRevision?: string; ifNoneMatch?: true }
export interface SyncIssue { id: string; kind: "conflict" | "sync-failed"; path?: string; conflictPath?: string; detail: string; createdAt: string; reviewed?: boolean; base?: unknown; local?: unknown; remote?: unknown }

/** State stays outside vault files and is scoped to one local vault installation. */
function scoped(key: string, scope = "default"): string { return `${key}.${scope}`; }
export function loadSyncState(scope?: string): SyncState | undefined {
  try { const raw = window.localStorage.getItem(scoped(KEY, scope)); return raw ? JSON.parse(raw) as SyncState : undefined; } catch { return undefined; }
}
export function saveSyncState(entries: readonly SyncEntry[], revision: string, scope?: string): void {
  window.localStorage.setItem(scoped(KEY, scope), JSON.stringify({ entries, revision, updatedAt: new Date().toISOString() }));
}
export function clearSyncState(scope?: string): void { try { window.localStorage.removeItem(scoped(KEY, scope)); } catch { /* no local storage */ } }

function pendingUploads(scope?: string): Record<string, PendingUpload> {
  try {
    const value = JSON.parse(window.localStorage.getItem(scoped(PENDING_UPLOADS_KEY, scope)) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function loadPendingUpload(path: string, scope?: string): PendingUpload | undefined {
  const value = pendingUploads(scope)[path];
  return value && typeof value.uploadId === "string" && typeof value.sha256 === "string" && Number.isInteger(value.size) ? value : undefined;
}
export function savePendingUpload(value: PendingUpload, scope?: string): void {
  const uploads = pendingUploads(scope); uploads[value.path] = value;
  window.localStorage.setItem(scoped(PENDING_UPLOADS_KEY, scope), JSON.stringify(uploads));
}
export function clearPendingUpload(path: string, scope?: string): void {
  const uploads = pendingUploads(scope); delete uploads[path];
  try { window.localStorage.setItem(scoped(PENDING_UPLOADS_KEY, scope), JSON.stringify(uploads)); } catch { /* no local storage */ }
}
export function loadSyncIssues(scope?: string): SyncIssue[] {
  try { const value = JSON.parse(window.localStorage.getItem(scoped(ISSUES_KEY, scope)) || "[]"); return Array.isArray(value) ? value.filter(item => item && typeof item.id === "string" && typeof item.kind === "string") : []; } catch { return []; }
}
export function saveSyncIssues(value: SyncIssue[], scope?: string): void { try { window.localStorage.setItem(scoped(ISSUES_KEY, scope), JSON.stringify(value.slice(-100))); } catch { /* no local storage */ } }
export function recordSyncResult(result: { conflicts?: number; conflictPaths?: string[]; conflictDetails?: Array<{ path: string; conflictPath?: string; base?: unknown; local?: unknown; remote?: unknown }> }, scope?: string): void {
  const issues = loadSyncIssues(scope); const details = result.conflictDetails || [];
  for (const path of result.conflictPaths || []) {
    const detail = details.find(item => item.conflictPath === path || item.path === path);
    issues.push({ id: `${Date.now()}-${path}`, kind: "conflict", path: detail?.path || path, conflictPath: path, base: detail?.base, local: detail?.local, remote: detail?.remote, detail: "Both copies changed; the local copy was preserved as a conflict file.", createdAt: new Date().toISOString() });
  }
  saveSyncIssues(issues, scope);
}
export function recordSyncFailure(error: unknown, scope?: string): void { const detail = error instanceof Error ? error.message : "Vault synchronization could not complete."; const issues = loadSyncIssues(scope); issues.push({ id: `${Date.now()}-failure`, kind: "sync-failed", detail, createdAt: new Date().toISOString() }); saveSyncIssues(issues, scope); }
export function markIssueReviewed(id: string, scope?: string): void { saveSyncIssues(loadSyncIssues(scope).map(item => item.id === id ? { ...item, reviewed: true } : item), scope); }
export function markSetupCopyRecovered(path: string, scope?: string): void {
  saveSyncIssues(loadSyncIssues(scope).map(item => item.kind === "conflict" && item.path === path ? { ...item, reviewed: true } : item), scope);
}
