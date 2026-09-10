import type { Transport } from "./api";
export interface SyncEntry { path: string; sha256: string; size: number; modifiedAt: string; revision?: string; sequence?: number; fileId?: string; acceptedAt?: string; device?: string; kind?: string; parentRevision?: string; renamedFrom?: string; restoredFrom?: string }
export interface SyncManifest { apiVersion: 1; revision: string; entries: SyncEntry[] }
export interface UploadSession { apiVersion: 1; uploadId: string; offset: number; size: number; chunkSize: number }
export interface UploadStart { path: string; size: number; sha256: string; ifMatch?: string; ifNoneMatch?: true; ifRevision?: string }
export function pathUrl(path: string): string { return "/sync/v1/files/" + path.split("/").map(encodeURIComponent).join("/"); }
export async function syncRequest(transport: Transport, base: string, token: string, path: string, method = "GET", body?: string | ArrayBuffer, condition: Record<string, string> = {}, contentType = "application/octet-stream"): Promise<any> {
  if (!token) throw new Error("Connect this device to NAS first.");
  const url = new URL(base.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Configure a valid private vault-sync API URL.");
  if (!path.startsWith("/sync/v1/") || path.includes("..")) throw new Error("Invalid vault-sync API path.");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", ...condition };
  if (body !== undefined) headers["Content-Type"] = contentType;
  let response: any; try { response = await transport({ url: base.replace(/\/$/, "") + path, method, headers, body, throw: false }); } catch { throw new Error("Cannot reach the private vault-sync service."); }
  if (response.status === 401 || response.status === 403) throw new Error("Vault sync access denied.");
  if (response.status === 409 || response.status === 412) throw new Error("Vault changed remotely; preserve a conflict and refresh.");
  if (response.status < 200 || response.status >= 300) throw new Error(`Vault sync failed (HTTP ${response.status}).`);
  return response;
}
export async function manifest(transport: Transport, base: string, token: string): Promise<SyncManifest> { const r = await syncRequest(transport, base, token, "/sync/v1/manifest"); const data = JSON.parse(r.text); if (!data || data.apiVersion !== 1 || !Array.isArray(data.entries)) throw new Error("Vault sync API version is incompatible."); return data; }

function uploadSession(response: any): UploadSession {
  let value: any; try { value = JSON.parse(response.text); } catch { throw new Error("Vault sync API returned an invalid upload response."); }
  if (!value || value.apiVersion !== 1 || typeof value.uploadId !== "string" || !Number.isInteger(value.offset) || !Number.isInteger(value.size) || !Number.isInteger(value.chunkSize) || value.offset < 0 || value.offset > value.size || value.chunkSize < 1) throw new Error("Vault sync API returned an incompatible upload response.");
  return value;
}

export async function startUpload(transport: Transport, base: string, token: string, value: UploadStart): Promise<UploadSession> {
  return uploadSession(await syncRequest(transport, base, token, "/sync/v1/uploads", "POST", JSON.stringify(value), {}, "application/json"));
}
export async function uploadStatus(transport: Transport, base: string, token: string, uploadId: string): Promise<UploadSession> {
  return uploadSession(await syncRequest(transport, base, token, `/sync/v1/uploads/${encodeURIComponent(uploadId)}`));
}
export async function uploadChunk(transport: Transport, base: string, token: string, uploadId: string, offset: number, bytes: ArrayBuffer): Promise<UploadSession> {
  return uploadSession(await syncRequest(transport, base, token, `/sync/v1/uploads/${encodeURIComponent(uploadId)}`, "PUT", bytes, { "X-Upload-Offset": String(offset) }));
}
export async function commitUpload(transport: Transport, base: string, token: string, uploadId: string): Promise<void> {
  await syncRequest(transport, base, token, `/sync/v1/uploads/${encodeURIComponent(uploadId)}/commit`, "POST");
}
export async function history(transport: Transport, base: string, token: string, path?: string): Promise<any[]> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
  const value = JSON.parse((await syncRequest(transport, base, token, `/sync/v1/history${suffix}`)).text);
  return Array.isArray(value.entries) ? value.entries : [];
}
export async function trash(transport: Transport, base: string, token: string): Promise<any[]> {
  const value = JSON.parse((await syncRequest(transport, base, token, "/sync/v1/trash")).text);
  return Array.isArray(value.entries) ? value.entries : [];
}
export async function revisionContent(transport: Transport, base: string, token: string, revision: string): Promise<ArrayBuffer> {
  const response = await syncRequest(transport, base, token, `/sync/v1/revisions/${encodeURIComponent(revision)}`);
  if (!response.arrayBuffer) throw new Error("Revision content was unavailable.");
  return response.arrayBuffer;
}
export async function restoreRevision(transport: Transport, base: string, token: string, revision: string): Promise<any> {
  return JSON.parse((await syncRequest(transport, base, token, "/sync/v1/trash/restore", "POST", JSON.stringify({ revision }), {}, "application/json")).text);
}
export async function renameRemote(transport: Transport, base: string, token: string, path: string, newPath: string, ifMatch?: string, ifRevision?: string): Promise<any> {
  const body = { path, newPath, ...(ifMatch ? { ifMatch } : {}), ...(ifRevision ? { ifRevision } : {}) };
  return JSON.parse((await syncRequest(transport, base, token, "/sync/v1/files/rename", "POST", JSON.stringify(body), {}, "application/json")).text);
}
export async function exportAccount(transport: Transport, base: string, token: string): Promise<ArrayBuffer> {
  const response = await syncRequest(transport, base, token, "/sync/v1/account/export");
  if (!response.arrayBuffer) throw new Error("Account export was unavailable.");
  return response.arrayBuffer;
}
export async function importAccount(transport: Transport, base: string, token: string, archive: ArrayBuffer, dryRun = false): Promise<any> {
  const suffix = dryRun ? "?dryRun=1" : "";
  const response = await syncRequest(transport, base, token, `/sync/v1/account/import${suffix}`, "POST", archive, {}, "application/zip");
  return JSON.parse(response.text);
}
