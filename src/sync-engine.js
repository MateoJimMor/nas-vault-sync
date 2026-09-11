const { requestUrl } = require("obsidian");
const { manifest, pathUrl, syncRequest, startUpload, uploadStatus, uploadChunk, commitUpload, renameRemote } = require("./sync-api");
const { classifyVaultPath } = require("./scope");
const { conflictPath, sourcePathForConflictCopy } = require("./sync-plan");
const { reconcile } = require("./sync-reconcile");
const { loadSyncState, saveSyncState, loadPendingUpload, savePendingUpload, clearPendingUpload, recordSyncResult, markSetupCopyRecovered, loadSyncTransaction, saveSyncTransaction, clearSyncTransaction, loadConflictRecord, saveConflictRecord } = require("./sync-state");

const FALLBACK_CHUNK_SIZE = 4 * 1024 * 1024;
const INITIAL_SYNC_CONCURRENCY = 3;
const syncBase = plugin => plugin.syncBaseUrl ? plugin.syncBaseUrl() : plugin.settings.syncApiBaseUrl;
const deviceCredential = plugin => plugin.getDeviceCredential ? plugin.getDeviceCredential() : plugin.getSyncToken();
const stateScope = plugin => plugin.syncStateScope ? plugin.syncStateScope() : undefined;

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

async function downloadBytes(plugin, entry) {
  const condition = { "If-Match": `"${entry.sha256}"` };
  if (entry.size === 0) {
    const response = await syncRequest(requestUrl, syncBase(plugin), deviceCredential(plugin), pathUrl(entry.path), "GET", undefined, condition);
    return response.arrayBuffer;
  }
  const target = new Uint8Array(entry.size);
  for (let offset = 0; offset < entry.size; offset += FALLBACK_CHUNK_SIZE) {
    const end = Math.min(entry.size, offset + FALLBACK_CHUNK_SIZE) - 1;
    const response = await syncRequest(requestUrl, syncBase(plugin), deviceCredential(plugin), pathUrl(entry.path), "GET", undefined, { ...condition, Range: `bytes=${offset}-${end}` });
    const chunk = new Uint8Array(response.arrayBuffer);
    if (chunk.byteLength !== end - offset + 1) throw new Error("Vault sync download was truncated; refresh before retrying.");
    target.set(chunk, offset);
  }
  if (await sha256(target.buffer) !== entry.sha256) throw new Error("Vault sync download did not match the server digest.");
  return target.buffer;
}

async function download(plugin, entry) {
  const bytes = await downloadBytes(plugin, entry);
  await ensureParentDirectory(plugin, entry.path);
  await plugin.app.vault.adapter.writeBinary(entry.path, bytes);
}

async function preserveLocalConflict(plugin, path, identity = {}) {
  const adapter = plugin.app.vault.adapter;
  if (!await adapter.exists(path)) return undefined;
  const localBytes = await adapter.readBinary(path);
  const localSha256 = identity.localSha256 || await sha256(localBytes);
  const key = [path, localSha256, identity.baseRevision || "", identity.remoteRevision || identity.remoteSha256 || ""].join("|");
  const previous = typeof loadConflictRecord === "function" ? loadConflictRecord(key, stateScope(plugin)) : undefined;
  if (previous?.conflictPath && await adapter.exists(previous.conflictPath)) return previous.conflictPath;
  const conflict = conflictPath(path, plugin.settings.syncDeviceName || "device", new Date().toISOString());
  await ensureParentDirectory(plugin, conflict);
  await adapter.writeBinary(conflict, localBytes);
  if (typeof saveConflictRecord === "function") saveConflictRecord(key, { conflictPath: conflict, path, localSha256, baseRevision: identity.baseRevision, remoteRevision: identity.remoteRevision, createdAt: new Date().toISOString() }, stateScope(plugin));
  return conflict;
}

function completionFor(action) {
  if (action.kind === "delete-local" || action.kind === "delete-remote") return { absent: true };
  if (action.kind === "conflict") return { localSha256: action.remote?.sha256, remoteSha256: action.remote?.sha256, remoteRevision: action.remote?.revision };
  if (action.kind === "download") return { localSha256: action.remote?.sha256, remoteSha256: action.remote?.sha256, remoteRevision: action.remote?.revision };
  if (action.kind === "upload") return { localSha256: action.local?.sha256, remoteSha256: action.local?.sha256 };
  return {};
}

function completionStillValid(action, completion, localByPath, remoteByPath) {
  if (!completion) return false;
  if (completion.absent) return !localByPath.has(action.path) && !remoteByPath.has(action.path);
  const local = localByPath.get(action.path), remote = remoteByPath.get(action.path);
  return Boolean(local && remote)
    && (!completion.localSha256 || local.sha256 === completion.localSha256)
    && (!completion.remoteSha256 || remote.sha256 === completion.remoteSha256)
    && (!completion.remoteRevision || remote.revision === completion.remoteRevision);
}

function recordCompletion(transaction, action) {
  transaction.completed[action.path] = completionFor(action);
  transaction.updatedAt = new Date().toISOString();
  return transaction;
}

function initialTransaction(plugin, mode, revision) {
  const existing = typeof loadSyncTransaction === "function" ? loadSyncTransaction(stateScope(plugin)) : undefined;
  if (existing && (existing.mode || "ordinary") === mode) return existing;
  return { mode, baseRevision: revision, completed: {}, updatedAt: new Date().toISOString() };
}

// The initial pass is deliberately checkpointed after every verified file. A
// later manifest may have a different overall revision, so completion is
// validated by the file digest rather than by the manifest revision alone.
function saveInitialTransaction(plugin, transaction) {
  if (typeof saveSyncTransaction === "function") saveSyncTransaction(transaction, stateScope(plugin));
}
function clearInitialTransaction(plugin) {
  if (typeof clearSyncTransaction === "function") clearSyncTransaction(stateScope(plugin));
}
async function localMatches(plugin, adapter, path, sha256sum) {
  return await adapter.exists(path) && await sha256(await adapter.readBinary(path)) === sha256sum;
}
function initialCompletion(transaction, path, entry) {
  transaction.completed[path] = { path, localSha256: entry.sha256, remoteSha256: entry.sha256, remoteRevision: entry.revision };
  transaction.updatedAt = new Date().toISOString();
}

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  let firstError;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (firstError === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try { await worker(items[index], index); }
      catch (error) { firstError = error; }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

function sameUpload(pending, local, remote) {
  return pending && pending.sha256 === local.sha256 && pending.size === local.size && pending.ifMatch === remote?.sha256 && pending.ifRevision === remote?.revision && Boolean(pending.ifNoneMatch) === !remote;
}

async function resumableUpload(plugin, local, remote) {
  const adapter = plugin.app.vault.adapter;
  const bytes = await adapter.readBinary(local.path);
  if (bytes.byteLength !== local.size || await sha256(bytes) !== local.sha256) throw new Error("The local file changed during synchronization; refresh before retrying.");
  const base = syncBase(plugin), token = deviceCredential(plugin);
  let pending = loadPendingUpload(local.path, stateScope(plugin)), session;
  if (sameUpload(pending, local, remote)) {
    try { session = await uploadStatus(requestUrl, base, token, pending.uploadId); }
    catch (_error) { pending = undefined; }
  }
  if (!session) {
    const start = { path: local.path, size: local.size, sha256: local.sha256, ...(remote ? { ifMatch: remote.sha256, ...(remote.revision ? { ifRevision: remote.revision } : {}) } : { ifNoneMatch: true }) };
    session = await startUpload(requestUrl, base, token, start);
    pending = { uploadId: session.uploadId, path: local.path, sha256: local.sha256, size: local.size, ...(remote ? { ifMatch: remote.sha256, ...(remote.revision ? { ifRevision: remote.revision } : {}) } : { ifNoneMatch: true }) };
    savePendingUpload(pending, stateScope(plugin));
  }
  if (session.size !== local.size || session.offset > local.size) throw new Error("The resumable upload state is incompatible; refresh before retrying.");
  while (session.offset < local.size) {
    const offset = session.offset, size = Math.min(session.chunkSize || FALLBACK_CHUNK_SIZE, local.size - offset);
    try { session = await uploadChunk(requestUrl, base, token, session.uploadId, offset, bytes.slice(offset, offset + size)); }
    catch (_error) { session = await uploadStatus(requestUrl, base, token, session.uploadId); }
    if (session.offset <= offset || session.offset > local.size) throw new Error("The resumable upload did not advance; refresh before retrying.");
    savePendingUpload(pending, stateScope(plugin));
  }
  await commitUpload(requestUrl, base, token, session.uploadId);
  clearPendingUpload(local.path, stateScope(plugin));
}

async function initialServerSync(plugin) {
  const remote = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  const adapter = plugin.app.vault.adapter;
  const result = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, skipped: 0 }, conflictPaths = [], conflictDetails = [];
  const remotePaths = new Set(remote.entries.map(entry => entry.path));
  const transaction = initialTransaction(plugin, "initial-server", remote.revision);
  await runWithConcurrency(remote.entries, INITIAL_SYNC_CONCURRENCY, async (entry) => {
    if (classifyVaultPath(entry.path).scope !== "shared") { result.skipped++; return; }
    // A completed file is valid only when its verified bytes are still local
    // and match the current server digest. This makes retries safe even if the
    // manifest revision changed because another file changed meanwhile.
    if (transaction.completed[entry.path]?.remoteSha256 === entry.sha256 && await localMatches(plugin, adapter, entry.path, entry.sha256)) {
      result.skipped++;
      return;
    }
    if (await adapter.exists(entry.path) && await sha256(await adapter.readBinary(entry.path)) === entry.sha256) {
      initialCompletion(transaction, entry.path, entry);
      saveInitialTransaction(plugin, transaction);
      result.skipped++;
    } else if (await adapter.exists(entry.path)) {
      const bytes = await downloadBytes(plugin, entry);
      const conflict = await preserveLocalConflict(plugin, entry.path, { remoteSha256: entry.sha256, remoteRevision: entry.revision, baseRevision: remote.revision });
      if (conflict) conflictPaths.push(conflict); await adapter.writeBinary(entry.path, bytes); result.conflicts++;
      result.downloaded++;
      initialCompletion(transaction, entry.path, entry);
      saveInitialTransaction(plugin, transaction);
    } else {
      await download(plugin, entry);
      result.downloaded++;
      initialCompletion(transaction, entry.path, entry);
      saveInitialTransaction(plugin, transaction);
    }
  });
  // Enumerate local-only files only after the remote pass. This keeps a large
  // vault from spending its entire first-sync startup hashing local content
  // before any missing server file can be downloaded.
  for (const entry of await localManifest(plugin)) {
    if (remotePaths.has(entry.path)) continue;
    if (classifyVaultPath(entry.path).scope !== "shared") { result.skipped++; continue; }
    if (transaction.completed[entry.path]?.absent && !await adapter.exists(entry.path)) { result.skipped++; continue; }
    const conflict = await preserveLocalConflict(plugin, entry.path); if (conflict) conflictPaths.push(conflict);
    await adapter.remove(entry.path);
    result.conflicts++;
    transaction.completed[entry.path] = { path: entry.path, absent: true };
    transaction.updatedAt = new Date().toISOString();
    saveInitialTransaction(plugin, transaction);
  }
  saveSyncState(remote.entries, remote.revision, stateScope(plugin));
  clearInitialTransaction(plugin);
  if (typeof recordSyncResult === "function") recordSyncResult({ ...result, conflictPaths }, stateScope(plugin)); return result;
}

async function initialLocalImport(plugin) {
  const remote = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  const remoteByPath = new Map(remote.entries.map(entry => [entry.path, entry]));
  const result = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, skipped: 0 }, conflictPaths = [];
  const transaction = initialTransaction(plugin, "initial-local", remote.revision);
  for (const entry of await localManifest(plugin)) {
    if (classifyVaultPath(entry.path).scope !== "shared") { result.skipped++; continue; }
    const server = remoteByPath.get(entry.path);
    const completed = transaction.completed[entry.path];
    if (completed?.localSha256 === entry.sha256 && (!server || completed.remoteSha256 === server.sha256)) { result.skipped++; continue; }
    if (!server) {
      await resumableUpload(plugin, entry, undefined);
      transaction.completed[entry.path] = { path: entry.path, localSha256: entry.sha256, remoteSha256: entry.sha256 };
      transaction.updatedAt = new Date().toISOString(); saveInitialTransaction(plugin, transaction);
      result.uploaded++; continue;
    }
    if (server.sha256 === entry.sha256) {
      transaction.completed[entry.path] = { path: entry.path, localSha256: entry.sha256, remoteSha256: server.sha256, remoteRevision: server.revision };
      transaction.updatedAt = new Date().toISOString(); saveInitialTransaction(plugin, transaction);
      result.skipped++; continue;
    }
    const conflict = await preserveLocalConflict(plugin, entry.path); if (conflict) conflictPaths.push(conflict);
    await download(plugin, server); result.downloaded++; result.conflicts++;
    transaction.completed[entry.path] = { path: entry.path, localSha256: server.sha256, remoteSha256: server.sha256, remoteRevision: server.revision };
    transaction.updatedAt = new Date().toISOString(); saveInitialTransaction(plugin, transaction);
  }
  const completed = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  saveSyncState(completed.entries, completed.revision, stateScope(plugin));
  clearInitialTransaction(plugin);
  if (typeof recordSyncResult === "function") recordSyncResult({ ...result, conflictPaths }, stateScope(plugin)); return result;
}

async function recoverableSetupCopies(plugin) {
  const remote = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  const remotePaths = new Set(remote.entries.map(entry => entry.path));
  const adapter = plugin.app.vault.adapter;
  const copies = [];
  for (const file of plugin.app.vault.getFiles()) {
    const originalPath = sourcePathForConflictCopy(file.path);
    if (!originalPath || classifyVaultPath(originalPath).scope !== "shared") continue;
    if (await adapter.exists(originalPath) || remotePaths.has(originalPath)) continue;
    copies.push({ conflictPath: file.path, originalPath });
  }
  return copies.sort((left, right) => left.originalPath.localeCompare(right.originalPath));
}

async function recoverSetupCopies(plugin, requestedCopies) {
  const candidates = await recoverableSetupCopies(plugin);
  const requested = new Set((requestedCopies || []).map(copy => typeof copy === "string" ? copy : copy?.conflictPath));
  const copies = requested.size ? candidates.filter(copy => requested.has(copy.conflictPath)) : candidates;
  const adapter = plugin.app.vault.adapter;
  const result = { restored: 0, uploaded: 0, skipped: candidates.length - copies.length };
  for (const copy of copies) {
    // Recheck before writing: this recovery path must never overwrite a local or server original.
    if (!await adapter.exists(copy.conflictPath) || await adapter.exists(copy.originalPath)) { result.skipped++; continue; }
    const bytes = await adapter.readBinary(copy.conflictPath);
    await ensureParentDirectory(plugin, copy.originalPath);
    await adapter.writeBinary(copy.originalPath, bytes);
    const local = { path: copy.originalPath, sha256: await sha256(bytes), size: bytes.byteLength, modifiedAt: new Date().toISOString() };
    await resumableUpload(plugin, local, undefined);
    result.restored++; result.uploaded++;
    if (typeof markSetupCopyRecovered === "function") markSetupCopyRecovered(copy.conflictPath, stateScope(plugin));
  }
  const completed = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  saveSyncState(completed.entries, completed.revision, stateScope(plugin));
  return result;
}

async function syncNow(plugin) {
  const state = loadSyncState(stateScope(plugin));
  if (!state) throw new Error("Run Initial server-authoritative vault sync before ordinary synchronization.");
  const remote = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  const local = await localManifest(plugin);
  const result = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, skipped: 0 }, conflictPaths = [], conflictDetails = [];
  const localByPath = new Map(local.map(item => [item.path, item]));
  const remoteByPath = new Map(remote.entries.map(item => [item.path, item]));
  const existing = typeof loadSyncTransaction === "function" ? loadSyncTransaction(stateScope(plugin)) : undefined;
  const transaction = existing && existing.baseRevision === state.revision ? existing : { baseRevision: state.revision, completed: {}, updatedAt: new Date().toISOString() };
  for (const action of reconcile(state.entries, local, remote.entries)) {
    if (action.kind === "none") continue;
    if (classifyVaultPath(action.path).scope !== "shared") { result.skipped++; continue; }
    if (completionStillValid(action, transaction.completed[action.path], localByPath, remoteByPath)) continue;
    if (action.kind === "download") { await download(plugin, action.remote); result.downloaded++; recordCompletion(transaction, action); if (typeof saveSyncTransaction === "function") saveSyncTransaction(transaction, stateScope(plugin)); continue; }
    if (action.kind === "delete-local") { await plugin.app.vault.adapter.remove(action.path); result.deleted++; recordCompletion(transaction, action); if (typeof saveSyncTransaction === "function") saveSyncTransaction(transaction, stateScope(plugin)); continue; }
    if (action.kind === "upload") {
      await resumableUpload(plugin, action.local, action.remote); result.uploaded++; recordCompletion(transaction, action); if (typeof saveSyncTransaction === "function") saveSyncTransaction(transaction, stateScope(plugin)); continue;
    }
    if (action.kind === "delete-remote") { await syncRequest(requestUrl, syncBase(plugin), deviceCredential(plugin), pathUrl(action.path), "DELETE", undefined, { "If-Match": `"${action.remote.sha256}"`, ...(action.remote.revision ? { "X-NAS-Revision": action.remote.revision } : {}) }); result.deleted++; recordCompletion(transaction, action); if (typeof saveSyncTransaction === "function") saveSyncTransaction(transaction, stateScope(plugin)); continue; }
    if (action.remote) {
      const bytes = await downloadBytes(plugin, action.remote);
      const conflict = await preserveLocalConflict(plugin, action.path, { localSha256: action.local?.sha256, remoteSha256: action.remote.sha256, remoteRevision: action.remote.revision, baseRevision: action.base?.revision || state.revision });
      if (conflict) conflictPaths.push(conflict); conflictDetails.push({ path: action.path, conflictPath: conflict, base: action.base, local: action.local, remote: action.remote });
      await ensureParentDirectory(plugin, action.path); await plugin.app.vault.adapter.writeBinary(action.path, bytes); result.downloaded++; result.conflicts++;
    } else {
      const conflict = await preserveLocalConflict(plugin, action.path, { localSha256: action.local?.sha256, baseRevision: action.base?.revision || state.revision });
      if (conflict) conflictPaths.push(conflict); conflictDetails.push({ path: action.path, conflictPath: conflict, base: action.base, local: action.local, remote: action.remote });
      await plugin.app.vault.adapter.remove(action.path); result.conflicts++;
    }
    recordCompletion(transaction, action); if (typeof saveSyncTransaction === "function") saveSyncTransaction(transaction, stateScope(plugin));
  }
  const completed = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  saveSyncState(completed.entries, completed.revision, stateScope(plugin));
  if (typeof clearSyncTransaction === "function") clearSyncTransaction(stateScope(plugin));
  if (typeof recordSyncResult === "function") recordSyncResult({ ...result, conflictPaths, conflictDetails }, stateScope(plugin)); return result;
}

async function renameNow(plugin, oldPath, newPath) {
  const state = loadSyncState(stateScope(plugin));
  if (!state) return false;
  const base = state.entries.find(entry => entry.path === oldPath);
  if (!base || !await plugin.app.vault.adapter.exists(newPath)) return false;
  const remote = (await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin))).entries.find(entry => entry.path === oldPath);
  if (!remote || remote.sha256 !== base.sha256) return false;
  await renameRemote(requestUrl, syncBase(plugin), deviceCredential(plugin), oldPath, newPath, remote.sha256, remote.revision);
  const completed = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  saveSyncState(completed.entries, completed.revision, stateScope(plugin));
  return true;
}
async function resolveConflict(plugin, issue, choice) {
  const remote = issue?.remote;
  if (!remote || !issue.path) throw new Error("This conflict no longer has a usable server revision.");
  if (choice === "server" || choice === "both") await download(plugin, remote);
  if (choice === "local") {
    const bytes = await plugin.app.vault.adapter.readBinary(issue.path);
    const local = { path: issue.path, sha256: await sha256(bytes), size: bytes.byteLength, modifiedAt: new Date().toISOString() };
    await resumableUpload(plugin, local, remote);
  }
  const completed = await manifest(requestUrl, syncBase(plugin), deviceCredential(plugin));
  saveSyncState(completed.entries, completed.revision, stateScope(plugin));
  return completed;
}
module.exports = { initialServerSync, initialLocalImport, recoverableSetupCopies, recoverSetupCopies, syncNow, localManifest, renameNow, resolveConflict };
