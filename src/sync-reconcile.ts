export interface SyncEntry { path: string; sha256: string; size: number; modifiedAt?: string }
export type SyncActionKind = "download" | "upload" | "delete-local" | "delete-remote" | "conflict" | "none";
export interface SyncAction { kind: SyncActionKind; path: string; base?: SyncEntry; local?: SyncEntry; remote?: SyncEntry }

function different(left?: SyncEntry, right?: SyncEntry): boolean {
  return (left?.sha256 || "") !== (right?.sha256 || "");
}

/** Reconciles hashes only; filesystem and network effects belong to sync-engine. */
export function reconcile(base: readonly SyncEntry[], local: readonly SyncEntry[], remote: readonly SyncEntry[]): SyncAction[] {
  const baseByPath = new Map(base.map(item => [item.path, item]));
  const localByPath = new Map(local.map(item => [item.path, item]));
  const remoteByPath = new Map(remote.map(item => [item.path, item]));
  const paths = new Set([...baseByPath.keys(), ...localByPath.keys(), ...remoteByPath.keys()]);
  return [...paths].sort().map(path => {
    const previous = baseByPath.get(path), here = localByPath.get(path), there = remoteByPath.get(path);
    const localChanged = different(previous, here), remoteChanged = different(previous, there);
    if (!localChanged && !remoteChanged) return { kind: "none", path, base: previous, local: here, remote: there };
    if (!localChanged) return { kind: there ? "download" : "delete-local", path, base: previous, local: here, remote: there };
    if (!remoteChanged) return { kind: here ? "upload" : "delete-remote", path, base: previous, local: here, remote: there };
    return { kind: "conflict", path, base: previous, local: here, remote: there };
  });
}
