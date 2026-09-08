const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
test("built plugin preserves calendar commands/settings and adds overview", async () => {
  class Plugin {
    constructor() { this.commands = []; this.app = { workspace: { on() {} }, vault: { on() {} } }; }
    async loadData() { return { apiBaseUrl: "http://example.invalid/calendar-api", calendarId: "existing" }; }
    registerView() {}
    addRibbonIcon() {}
    addCommand(command) { this.commands.push(command.id); }
    addSettingTab() {}
    registerEvent() {}
  }
  const obsidian = { Plugin, PluginSettingTab: class {}, ItemView: class {}, Modal: class {} };
  const context = { module: { exports: {} }, require: name => {
    assert.equal(name, "obsidian");
    return obsidian;
  } };
  vm.runInNewContext(readFileSync(join(__dirname, "../main.js"), "utf8"), context);
  assert.equal(typeof context.module.exports, "function");
  const plugin = new context.module.exports();
  await plugin.onload();
  assert.equal(plugin.settings.calendarId, "existing");
  for (const command of ["open-calendar", "refresh-calendar", "create-calendar-event", "open-todays-daily-note", "open-nas-overview", "sync-vault-now"]) {
    assert.ok(plugin.commands.includes(command));
  }
});
