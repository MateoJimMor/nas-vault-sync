const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash, webcrypto } = require("node:crypto");
const vm = require("node:vm");

function bytes(value) { return new Uint8Array(Buffer.from(value)).buffer; }
function text(value) { return Buffer.from(value).toString(); }

test("ordinary sync requires an explicit completed server-authoritative baseline", async () => {
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {}, "./scope": {}, "./sync-plan": {}, "./sync-reconcile": {},
    "./sync-state": { loadSyncState: () => undefined },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  await assert.rejects(() => context.module.exports.syncNow({}), /Initial server-authoritative vault sync/);
});

test("initial server-authoritative sync preserves local divergence without re-uploading it", async () => {
  const files = new Map([["note.md", bytes("local")], ["local-only.md", bytes("draft")]]);
  const remote = { path: "note.md", sha256: createHash("sha256").update("server").digest("hex"), size: 6, modifiedAt: "2026-09-08T00:00:00Z" };
  let saved;
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => ({ entries: [remote], revision: "server-revision" }),
      pathUrl: path => path,
      syncRequest: async () => ({ arrayBuffer: bytes("server") }),
    },
    "./scope": { classifyVaultPath: path => ({ scope: path.includes(".conflict-") ? "user-reviewed" : "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict-device-20260908T000000Z` },
    "./sync-reconcile": { reconcile: () => [] },
    "./sync-state": { loadSyncState: () => undefined, saveSyncState: (entries, revision) => { saved = { entries, revision }; }, loadPendingUpload: () => undefined, savePendingUpload: () => {}, clearPendingUpload: () => {} },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const adapter = {
    exists: async path => files.has(path),
    readBinary: async path => files.get(path),
    writeBinary: async (path, value) => files.set(path, value),
    remove: async path => files.delete(path),
  };
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" },
    getSyncToken: () => "test-token",
    app: { vault: {
      adapter,
      getFiles: () => [...files].map(([path, value]) => ({ path, stat: { mtime: 0 }, value })),
    } },
  };
  const result = await context.module.exports.initialServerSync(plugin);
  assert.deepEqual({ ...result }, { downloaded: 1, uploaded: 0, deleted: 0, conflicts: 2, skipped: 0 });
  assert.equal(text(files.get("note.md")), "server");
  assert.equal(files.has("local-only.md"), false);
  assert.equal(text(files.get("note.md.conflict-device-20260908T000000Z")), "local");
  assert.equal(text(files.get("local-only.md.conflict-device-20260908T000000Z")), "draft");
  assert.deepEqual(saved, { entries: [remote], revision: "server-revision" });
});

test("initial server-authoritative sync creates parent directories for downloaded files", async () => {
  const files = new Map();
  const directories = new Set();
  const remote = { path: "server-seed/01-server-seed.md", sha256: createHash("sha256").update("server").digest("hex"), size: 6, modifiedAt: "2026-09-08T00:00:00Z" };
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => ({ entries: [remote], revision: "server-revision" }),
      pathUrl: path => path,
      syncRequest: async () => ({ arrayBuffer: bytes("server") }),
    },
    "./scope": { classifyVaultPath: () => ({ scope: "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict` },
    "./sync-reconcile": { reconcile: () => [] },
    "./sync-state": { loadSyncState: () => undefined, saveSyncState: () => {}, loadPendingUpload: () => undefined, savePendingUpload: () => {}, clearPendingUpload: () => {} },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const adapter = {
    exists: async path => files.has(path) || directories.has(path),
    mkdir: async path => directories.add(path),
    readBinary: async path => files.get(path),
    writeBinary: async (path, value) => files.set(path, value),
    remove: async path => files.delete(path),
  };
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" },
    getSyncToken: () => "test-token",
    app: { vault: { adapter, getFiles: () => [] } },
  };
  const result = await context.module.exports.initialServerSync(plugin);
  assert.equal(result.downloaded, 1);
  assert.deepEqual([...directories], ["server-seed"]);
  assert.equal(text(files.get(remote.path)), "server");
});

test("initial local import uploads local-only files without falsely preserving them as conflicts", async () => {
  const localOnly = bytes("");
  const remoteSame = { path: "same.md", sha256: createHash("sha256").update("same").digest("hex"), size: 4, modifiedAt: "2026-09-08T00:00:00Z" };
  const files = new Map([["same.md", bytes("same")], ["local-only.md", localOnly]]);
  const uploaded = [];
  let saved;
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => ({ entries: [remoteSame], revision: "server-revision" }),
      pathUrl: path => path,
      startUpload: async (_requestUrl, _base, _token, value) => { uploaded.push(value); return { uploadId: "upload-id", offset: 0, size: value.size, chunkSize: 4 }; },
      uploadStatus: async () => { throw new Error("not used"); },
      uploadChunk: async () => { throw new Error("not used"); },
      commitUpload: async () => {},
    },
    "./scope": { classifyVaultPath: () => ({ scope: "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict` },
    "./sync-reconcile": { reconcile: () => [] },
    "./sync-state": { loadSyncState: () => undefined, saveSyncState: (entries, revision) => { saved = { entries, revision }; }, loadPendingUpload: () => undefined, savePendingUpload: () => {}, clearPendingUpload: () => {} },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" }, getSyncToken: () => "test-token",
    app: { vault: { adapter: { exists: async path => files.has(path), readBinary: async path => files.get(path), writeBinary: async (path, value) => files.set(path, value), remove: async path => files.delete(path) }, getFiles: () => [...files].map(([path]) => ({ path, stat: { mtime: 0 } })) } },
  };
  const result = await context.module.exports.initialLocalImport(plugin);
  assert.deepEqual({ ...result }, { downloaded: 0, uploaded: 1, deleted: 0, conflicts: 0, skipped: 0 });
  assert.deepEqual(uploaded.map(value => ({ ...value })), [{ path: "local-only.md", size: 0, sha256: createHash("sha256").update("").digest("hex"), ifNoneMatch: true }]);
  assert.equal(files.has("local-only.md.conflict"), false);
  assert.deepEqual(saved, { entries: [remoteSame], revision: "server-revision" });
});

test("recovery only restores a protected setup copy when its original is absent locally and remotely", async () => {
  const conflict = "folder/note.conflict-device-2026-09-10T191544202Z.md";
  const original = "folder/note.md";
  const files = new Map([[conflict, bytes("")]]);
  const directories = new Set();
  const uploaded = [], recovered = [];
  let manifestCalls = 0, saved;
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => (++manifestCalls === 1 ? { entries: [], revision: "before" } : { entries: [], revision: "after" }),
      pathUrl: path => path,
      startUpload: async (_requestUrl, _base, _token, value) => { uploaded.push(value); return { uploadId: "upload-id", offset: 0, size: 0, chunkSize: 4 }; },
      uploadStatus: async () => { throw new Error("not used"); }, uploadChunk: async () => { throw new Error("not used"); }, commitUpload: async () => {},
    },
    "./scope": { classifyVaultPath: () => ({ scope: "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict`, sourcePathForConflictCopy: path => path === conflict ? original : undefined },
    "./sync-reconcile": { reconcile: () => [] },
    "./sync-state": { loadSyncState: () => undefined, saveSyncState: (entries, revision) => { saved = { entries, revision }; }, loadPendingUpload: () => undefined, savePendingUpload: () => {}, clearPendingUpload: () => {}, markSetupCopyRecovered: path => recovered.push(path) },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error, Set };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" }, getSyncToken: () => "test-token",
    app: { vault: { adapter: { exists: async path => files.has(path) || directories.has(path), mkdir: async path => directories.add(path), readBinary: async path => files.get(path), writeBinary: async (path, value) => files.set(path, value) }, getFiles: () => [...files].map(([path]) => ({ path, stat: { mtime: 0 } })) } },
  };
  const candidates = await context.module.exports.recoverableSetupCopies(plugin);
  assert.deepEqual([...candidates].map(copy => ({ ...copy })), [{ conflictPath: conflict, originalPath: original }]);
  const result = await context.module.exports.recoverSetupCopies(plugin, candidates);
  assert.deepEqual({ ...result }, { restored: 1, uploaded: 1, skipped: 0 });
  assert.equal(files.has(conflict), true);
  assert.equal(files.has(original), true);
  assert.deepEqual(uploaded.map(value => ({ ...value })), [{ path: original, size: 0, sha256: createHash("sha256").update("").digest("hex"), ifNoneMatch: true }]);
  assert.deepEqual(recovered, [conflict]);
  assert.deepEqual(saved, { entries: [], revision: "after" });
});

test("normal sync resumes an interrupted chunk upload before committing", async () => {
  const sha256 = createHash("sha256").update("hello").digest("hex");
  const local = { path: "note.md", sha256, size: 5, modifiedAt: "2026-09-08T00:00:00Z" };
  const remote = { path: "note.md", sha256: "a".repeat(64), size: 3, modifiedAt: "2026-09-07T00:00:00Z" };
  const files = new Map([["note.md", bytes("hello")]]);
  const chunks = [], pending = [], cleared = [];
  let manifestCalls = 0, committed = false;
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => (++manifestCalls === 1 ? { entries: [remote], revision: "before" } : { entries: [local], revision: "after" }),
      pathUrl: path => path,
      syncRequest: async () => ({}),
      startUpload: async () => ({ uploadId: "upload-id", offset: 0, size: 5, chunkSize: 2 }),
      uploadStatus: async () => ({ uploadId: "upload-id", offset: 2, size: 5, chunkSize: 2 }),
      uploadChunk: async (_requestUrl, _base, _token, _id, offset, value) => {
        chunks.push([offset, text(value)]);
        if (offset === 0) throw new Error("response lost after server write");
        return { uploadId: "upload-id", offset: offset + value.byteLength, size: 5, chunkSize: 2 };
      },
      commitUpload: async () => { committed = true; },
    },
    "./scope": { classifyVaultPath: () => ({ scope: "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict` },
    "./sync-reconcile": { reconcile: () => [{ kind: "upload", path: "note.md", local, remote }] },
    "./sync-state": { loadSyncState: () => ({ entries: [remote], revision: "before" }), saveSyncState: () => {}, loadPendingUpload: () => undefined, savePendingUpload: value => pending.push(value), clearPendingUpload: path => cleared.push(path) },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" }, getSyncToken: () => "test-token",
    app: { vault: { adapter: { exists: async path => files.has(path), readBinary: async path => files.get(path), writeBinary: async (path, value) => files.set(path, value), remove: async path => files.delete(path) }, getFiles: () => [{ path: "note.md", stat: { mtime: 0 } }] } },
  };
  const result = await context.module.exports.syncNow(plugin);
  assert.deepEqual({ ...result }, { downloaded: 0, uploaded: 1, deleted: 0, conflicts: 0, skipped: 0 });
  assert.deepEqual(chunks, [[0, "he"], [2, "ll"], [4, "o"]]);
  assert.equal(pending.length, 4);
  assert.deepEqual(cleared, ["note.md"]);
  assert.equal(committed, true);
});

test("normal sync does not replay paths completed before an interrupted run", async () => {
  const oldA = { path: "a.md", sha256: "a".repeat(64), size: 3, modifiedAt: "2026-09-08T00:00:00Z", revision: "r-a" };
  const oldB = { path: "b.md", sha256: "b".repeat(64), size: 3, modifiedAt: "2026-09-08T00:00:00Z", revision: "r-b" };
  const newHash = createHash("sha256").update("new").digest("hex");
  const newA = { ...oldA, sha256: newHash, revision: "r-a2" };
  const newB = { ...oldB, sha256: newHash, revision: "r-b2" };
  const files = new Map([["a.md", bytes("old")], ["b.md", bytes("old")]]);
  let transaction;
  let failB = true;
  const downloads = [];
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => ({ entries: [newA, newB], revision: "remote-revision" }),
      pathUrl: path => path,
      syncRequest: async (_requestUrl, _base, _token, path) => {
        downloads.push(path);
        if (path === "b.md" && failB) { failB = false; throw new Error("temporary download failure"); }
        return { arrayBuffer: bytes(path === "a.md" ? "new" : "new") };
      },
    },
    "./scope": { classifyVaultPath: () => ({ scope: "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict` },
    "./sync-reconcile": { reconcile: () => [
      { kind: "download", path: "a.md", remote: newA },
      { kind: "download", path: "b.md", remote: newB },
    ] },
    "./sync-state": {
      loadSyncState: () => ({ entries: [oldA, oldB], revision: "base-revision" }),
      saveSyncState: () => {},
      loadPendingUpload: () => undefined, savePendingUpload: () => {}, clearPendingUpload: () => {},
      loadSyncTransaction: () => transaction,
      saveSyncTransaction: value => { transaction = JSON.parse(JSON.stringify(value)); },
      clearSyncTransaction: () => { transaction = undefined; },
    },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error, Map };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" }, getSyncToken: () => "test-token",
    app: { vault: { adapter: { exists: async path => files.has(path), readBinary: async path => files.get(path), writeBinary: async (path, value) => files.set(path, value), remove: async path => files.delete(path) }, getFiles: () => [...files].map(([path]) => ({ path, stat: { mtime: 0 } })) } },
  };
  await assert.rejects(() => context.module.exports.syncNow(plugin), /temporary download failure/);
  assert.deepEqual(downloads, ["a.md", "b.md"]);
  const result = await context.module.exports.syncNow(plugin);
  assert.equal(result.downloaded, 1);
  assert.deepEqual(downloads, ["a.md", "b.md", "b.md"]);
  assert.equal(transaction, undefined);
});
