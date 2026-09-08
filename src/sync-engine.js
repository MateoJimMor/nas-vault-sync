const { requestUrl } = require("obsidian");
const { manifest, pathUrl, syncRequest, startUpload, uploadStatus, uploadChunk, commitUpload } = require("./sync-api");
const { classifyVaultPath } = require("./scope");
const { conflictPath } = require("./sync-plan");
const { reconcile } = require("./sync-reconcile");
const { loadSyncState, saveSyncState, loadPendingUpload, savePendingUpload, clearPendingUpload } = require("./sync-state");

const FALLBACK_CHUNK_SIZE = 4 * 1024 * 1024;

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("");
}

async function localManifest(plugin) {
  const entries = [];
  for (const file of plugin.app.vault.getFiles()) {
    if (classifyVaultPath(file.path).scope !== "shared") continue;
    const bytes = await plugin.app.vault.adapter.readBinary(file.path);
    entries.push({ path: file.path, sha256: await sha256(bytes), size: bytes.byteLength, modifiedAt: new Date(file.stat.mtime).toISOString() });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function ensureParentDirectory(plugin, path) {
  const adapter = plugin.app.vault.adapter;
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!await adapter.exists(current)) await adapter.mkdir(current);
  }
}

async function download(plugin, entry) {
  const condition = { "If-Match": `"${entry.sha256}"` };
  await ensureParentDirectory(plugin, entry.path);
  if (entry.size === 0) {
    const response = await syncRequest(requestUrl, plugin.settings.syncApiBaseUrl, plugin.getSyncToken(), pathUrl(entry.path), "GET", undefined, condition);
    await plugin.app.vault.adapter.writeBinary(entry.path, response.arrayBuffer);
    return;
  }
  const target = new Uint8Array(entry.size);
  for (let offset = 0; offset < entry.size; offset += FALLBACK_CHUNK_SIZE) {
    const end = Math.min(entry.size, offset + FALLBACK_CHUNK_SIZE) - 1;
    const response = await syncRequest(requestUrl, plugin.settings.syncApiBaseUrl, plugin.getSyncToken(), pathUrl(entry.path), "GET", undefined, { ...condition, Range: `bytes=${offset}-${end}` });
    const chunk = new Uint8Array(response.arrayBuffer);
    if (chunk.byteLength !== end - offset + 1) throw new Error("Vault sync download was truncated; refresh before retrying.");
    target.set(chunk, offset);
  }
  if (await sha256(target.buffer) !== entry.sha256) throw new Error("Vault sync download did not match the server digest.");
  await plugin.app.vault.adapter.writeBinary(entry.path, target.buffer);
}

async function preserveLocalConflict(plugin, path) {
  const adapter = plugin.app.vault.adapter;
  if (!await adapter.exists(path)) return;
  const conflict = conflictPath(path, plugin.settings.syncDeviceName || "device", new Date().toISOString());
  await ensureParentDirectory(plugin, conflict);
  await adapter.writeBinary(conflict, await adapter.readBinary(path));
}

function sameUpload(pending, local, remote) {
  return pending && pending.sha256 === local.sha256 && pending.size === local.size && pending.ifMatch === remote?.sha256 && Boolean(pending.ifNoneMatch) === !remote;
}

async function resumableUpload(plugin, local, remote) {
  const adapter = plugin.app.vault.adapter;
  const bytes = await adapter.readBinary(local.path);
  if (bytes.byteLength !== local.size || await sha256(bytes) !== local.sha256) throw new Error("The local file changed during synchronization; refresh before retrying.");
  const base = plugin.settings.syncApiBaseUrl, token = plugin.getSyncToken();
  let pending = loadPendingUpload(local.path), session;
  if (sameUpload(pending, local, remote)) {
    try { session = await uploadStatus(requestUrl, base, token, pending.uploadId); }
    catch (_error) { pending = undefined; }
  }
  if (!session) {
    const start = { path: local.path, size: local.size, sha256: local.sha256, ...(remote ? { ifMatch: remote.sha256 } : { ifNoneMatch: true }) };
    session = await startUpload(requestUrl, base, token, start);
    pending = { uploadId: session.uploadId, path: local.path, sha256: local.sha256, size: local.size, ...(remote ? { ifMatch: remote.sha256 } : { ifNoneMatch: true }) };
    savePendingUpload(pending);
  }
  if (session.size !== local.size || session.offset > local.size) throw new Error("The resumable upload state is incompatible; refresh before retrying.");
  while (session.offset < local.size) {
    const offset = session.offset, size = Math.min(session.chunkSize || FALLBACK_CHUNK_SIZE, local.size - offset);
    try { session = await uploadChunk(requestUrl, base, token, session.uploadId, offset, bytes.slice(offset, offset + size)); }
    catch (_error) { session = await uploadStatus(requestUrl, base, token, session.uploadId); }
    if (session.offset <= offset || session.offset > local.size) throw new Error("The resumable upload did not advance; refresh before retrying.");
    savePendingUpload(pending);
  }
  await commitUpload(requestUrl, base, token, session.uploadId);
  clearPendingUpload(local.path);
}

async function initialServerSync(plugin) {
  const remote = await manifest(requestUrl, plugin.settings.syncApiBaseUrl, plugin.getSyncToken());
  const adapter = plugin.app.vault.adapter;
  const result = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, skipped: 0 };
  const remotePaths = new Set(remote.entries.map(entry => entry.path));
  for (const entry of remote.entries) {
    if (classifyVaultPath(entry.path).scope !== "shared") { result.skipped++; continue; }
    if (await adapter.exists(entry.path) && await sha256(await adapter.readBinary(entry.path)) !== entry.sha256) { await preserveLocalConflict(plugin, entry.path); result.conflicts++; }
    await download(plugin, entry); result.downloaded++;
  }
  for (const entry of await localManifest(plugin)) {
    if (remotePaths.has(entry.path)) continue;
    await preserveLocalConflict(plugin, entry.path);
    await adapter.remove(entry.path);
    result.conflicts++;
  }
  saveSyncState(remote.entries, remote.revision);
  return result;
}

async function syncNow(plugin) {
  const state = loadSyncState();
  if (!state) throw new Error("Run Initial server-authoritative vault sync before ordinary synchronization.");
  const remote = await manifest(requestUrl, plugin.settings.syncApiBaseUrl, plugin.getSyncToken());
  const local = await localManifest(plugin);
  const result = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, skipped: 0 };
  for (const action of reconcile(state.entries, local, remote.entries)) {
    if (action.kind === "none") continue;
    if (classifyVaultPath(action.path).scope !== "shared") { result.skipped++; continue; }
    if (action.kind === "download") { await download(plugin, action.remote); result.downloaded++; continue; }
    if (action.kind === "delete-local") { await plugin.app.vault.adapter.remove(action.path); result.deleted++; continue; }
    if (action.kind === "upload") {
      await resumableUpload(plugin, action.local, action.remote); result.uploaded++; continue;
    }
    if (action.kind === "delete-remote") { await syncRequest(requestUrl, plugin.settings.syncApiBaseUrl, plugin.getSyncToken(), pathUrl(action.path), "DELETE", undefined, { "If-Match": `"${action.remote.sha256}"` }); result.deleted++; continue; }
    await preserveLocalConflict(plugin, action.path); result.conflicts++;
    if (action.remote) { await download(plugin, action.remote); result.downloaded++; } else await plugin.app.vault.adapter.remove(action.path);
  }
  const completed = await manifest(requestUrl, plugin.settings.syncApiBaseUrl, plugin.getSyncToken());
  saveSyncState(completed.entries, completed.revision);
  return result;
}
module.exports = { initialServerSync, syncNow, localManifest };
