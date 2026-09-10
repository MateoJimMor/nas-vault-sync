const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
class MockPlugin {
  constructor() {
    this.commands = [];
    this.loadResult = { apiBaseUrl: "http://example.invalid/calendar-api", calendarId: "existing" };
    this.legacyContent = "";
    this.app = {
      workspace: { on() {} },
      vault: {
        on() {},
        configDir: ".obsidian",
        adapter: { read: async () => this.legacyContent },
      },
    };
  }
  async loadData() { return this.loadResult; }
  async saveData(value) { this.savedData = value; }
  registerView() {}
  addRibbonIcon() {}
  addCommand(command) { this.commands.push(command.id); }
  addSettingTab() {}
  registerEvent() {}
}
const obsidian = {
  Plugin: MockPlugin,
  PluginSettingTab: class {},
  ItemView: class {},
  Modal: class {},
  normalizePath: value => value,
};

test("built plugin preserves calendar commands/settings and adds overview", async () => {
  const context = { module: { exports: {} }, URL, require: name => {
    assert.equal(name, "obsidian");
    return obsidian;
  } };
  vm.runInNewContext(readFileSync(join(__dirname, "../main.js"), "utf8"), context);
  assert.equal(typeof context.module.exports, "function");
  const plugin = new context.module.exports();
  await plugin.onload();
  assert.equal(plugin.settings.calendarId, undefined);
  assert.equal(plugin.settings.nasBaseUrl, "http://example.invalid");
  assert.equal(plugin.settings.apiBaseUrl, undefined);
  for (const command of ["open-calendar", "refresh-calendar", "create-calendar-event", "open-todays-daily-note", "open-nas-overview", "initial-local-vault-import", "sync-vault-now", "test-vault-sync-connection"]) {
    assert.ok(plugin.commands.includes(command));
  }
});

test("migrates settings from the former plugin ID when the new ID has no data", async () => {
  const legacyContext = { module: { exports: {} }, URL, require: name => {
    assert.equal(name, "obsidian");
    return obsidian;
  } };
  vm.runInNewContext(readFileSync(join(__dirname, "../main.js"), "utf8"), legacyContext);
  const plugin = new legacyContext.module.exports();
  plugin.loadResult = null;
  plugin.legacyContent = JSON.stringify({
    apiBaseUrl: "http://example.invalid/calendar-api",
    calendarId: "personal",
    syncApiBaseUrl: "http://example.invalid/vault-sync",
  });
  await plugin.onload();
  assert.equal(plugin.settings.nasBaseUrl, "http://example.invalid");
  assert.equal(plugin.settings.syncApiBaseUrl, undefined);
  assert.equal(plugin.savedData.calendarId, undefined);
});

test("portal connection polls the unified pairing endpoint and asks for the opted-in first-sync method", () => {
  const source = readFileSync(join(__dirname, "../src/calendar.js"), "utf8");
  const modal = source.slice(source.indexOf("class PortalEnrollmentModal"), source.indexOf("async function loadLegacySettings"));
  assert.match(modal, /pairing/);
  assert.match(modal, /\/api\/v2\/pairing\/poll/);
  assert.match(modal, /autoInitialSyncAfterPairing !== false/);
  assert.match(modal, /chooseInitialSync\(\)/);
  assert.match(modal, /loadSyncState\(this\.plugin\.syncStateScope\(\)\)/);
});

test("automatic local-change sync is silent while an explicit sync remains user-visible", () => {
  const source = readFileSync(join(__dirname, "../src/calendar.js"), "utf8");
  assert.match(source, /window\.setTimeout\(\(\) => this\.syncVaultNow\(\{ silent: true \}\), 3000\)/);
  assert.match(source, /setButtonText\("Sync now"\)\.onClick\(\(\) => this\.plugin\.syncVaultNow\(\)\)/);
});
