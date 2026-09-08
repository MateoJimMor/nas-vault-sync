const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const esbuild = require("esbuild");
const code = esbuild.transformSync(readFileSync(join(__dirname, "../src/scope.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const context = { module: { exports: {} } };
vm.runInNewContext(code, context);
const { classifyVaultPath, scopeSummary } = context.module.exports;

test("classifies ordinary notes and attachments as shared", () => {
  assert.equal(classifyVaultPath("03_Diary/2026/2026-09/2026-09-07.md").scope, "shared");
  assert.equal(classifyVaultPath("05_Resources/reading/paper.pdf").scope, "shared");
});

test("keeps workspace and cache state device-local", () => {
  for (const path of [".obsidian/workspace.json", ".obsidian/appearance.json", ".obsidian/cache/layout"])
    assert.equal(classifyVaultPath(path).scope, "device-local");
});

test("requires review for application resources, conflicts, and unsafe paths", () => {
  for (const path of [".obsidian/plugins/nas-calendar-bridge/data.json", ".git/index", "../outside.md", "/absolute.md", "folder\\file.md", "notes/a.conflict-phone-20260908T000000Z.md"])
    assert.equal(classifyVaultPath(path).scope, "user-reviewed");
  assert.equal(scopeSummary().length, 3);
});
