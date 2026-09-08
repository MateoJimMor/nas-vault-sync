const { Modal, Setting } = require("obsidian");
const { scopeSummary } = require("./scope");
const { connectionReadiness } = require("./connection");
const { readOnlySyncStatus } = require("./sync-status");
class NasOverview extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: "NAS Vault" });
    el.createEl("p", { text: "Your vault, calendar, and NAS connection." });
    el.createEl("h3", { text: "Connection" });
    const status = el.createEl("p", { text: "Not checked in this session." });
    const readiness = connectionReadiness(this.plugin.settings.apiBaseUrl, this.plugin.getToken());
    const setup = readiness.api === "ready"
      ? "Private API address configured."
      : readiness.api === "missing"
        ? "Private API address is not configured."
        : "Private API address needs correction.";
    const token = readiness.token === "present"
      ? "Device token is present in local storage."
      : "Device token is not configured on this device.";
    el.createEl("p", { text: `${setup} ${token} No address or token is displayed here.` });
    new Setting(el).setName("Calendar API").addButton(button => button.setButtonText("Check connection").onClick(async () => {
      button.setDisabled(true);
      status.setText("Checking…");
      try {
        const result = await this.plugin.health();
        status.setText(result.status === "ok" ? "Calendar API connected and authenticated." : "Server responded, but did not report healthy.");
      } catch (error) { status.setText(error.message); }
      finally { button.setDisabled(false); }
    }));
    new Setting(el).setName("Calendar").addButton(button => button.setButtonText("Open calendar").onClick(() => { this.close(); this.plugin.openCalendar(); }));
    el.createEl("h3", { text: "Vault synchronization" });
    const syncStatus = readOnlySyncStatus();
    el.createEl("p", { text: syncStatus.message });
    el.createEl("p", { text: "Use Sync Now for a manual three-way run. Concurrent changes are preserved as conflict files." });
    el.createEl("p", { text: "Automatic sync is disabled by default and must not be enabled while Syncthing writes this vault." });
    const scopeList = el.createEl("ul", { cls: "nas-vault__scope-list" });
    for (const summary of scopeSummary()) scopeList.createEl("li", { text: summary });
    el.createEl("h3", { text: "Archive and devices" });
    el.createEl("p", { text: "Use the Nextcloud desktop client for the temporary archive setup. NAS Companion pairing and archive integration are planned." });
    el.createEl("p", { text: "Calendar URL and device token are available in this plugin’s Obsidian settings." });
  }
  onClose() { this.contentEl.empty(); }
}
module.exports = { NasOverview };
