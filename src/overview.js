const { ItemView, Modal, Notice, Setting } = require("obsidian");
const { loadSyncState, loadSyncTransaction, loadSyncIssues, markIssueReviewed } = require("./sync-state");
const { recoverableSetupCopies } = require("./sync-engine");
const CONTROL_CENTER_VIEW_TYPE = "nas-vault-control-center";

function statusFor(plugin, connection) {
  if (!plugin.getDeviceCredential()) return { tone: "grey", label: "No account connected", detail: "Connect this device to an existing account or register a new one." };
  if (!connection?.calendar || !connection?.sync || !connection?.device) return { tone: "red", label: "NAS unavailable", detail: "This device is signed in, but the NAS cannot be reached or no longer accepts its access." };
  if (plugin.vaultSyncRunning) return { tone: "blue", label: "Syncing", detail: "Reconciling this device with your private server vault." };
  if (!plugin.settings.initialSyncCompleted || !loadSyncState(plugin.syncStateScope())) {
    const transaction = loadSyncTransaction(plugin.syncStateScope());
    return transaction
      ? { tone: "yellow", label: "Initial sync paused", detail: "A checkpoint is saved. Resume the vault sync to continue from the last verified file." }
      : { tone: "yellow", label: "Initial sync needed", detail: "The account is connected; choose whether this device imports its vault or begins from the server vault." };
  }
  return { tone: "green", label: "Synced and healthy", detail: "NAS services are reachable and the latest local sync state is ready." };
}

class NasControlCenterView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return CONTROL_CENTER_VIEW_TYPE; }
  getDisplayText() { return "NAS Vault"; }
  getIcon() { return "server"; }
  async onOpen() { await this.render(); }
  async onClose() { this.contentEl.empty(); }
  async render() {
    const el = this.contentEl; el.empty(); el.addClass("nas-vault-control-center"); el.createEl("h1", { text: "NAS Vault" });
    const data = await this.loadProfile(), status = statusFor(this.plugin, data.connection);
    const header = el.createDiv({ cls: `nas-vault-status nas-vault-status--${status.tone}` }); header.createSpan({ cls: "nas-vault-status__dot" });
    const copy = header.createDiv(); copy.createEl("strong", { text: data.profile?.username || "No account connected" }); copy.createEl("span", { text: status.label });
    if (this.plugin.getDeviceCredential()) {
      const check = header.createEl("button", { text: "Check connection", cls: "nas-vault-status__check" });
      check.onclick = async () => { check.disabled = true; await this.render(); };
    }
    el.createEl("p", { text: status.detail, cls: "nas-vault-status__detail" });
    const actions = el.createDiv({ cls: "nas-vault-actions" });
    const action = (label, callback, primary = false) => { const button = actions.createEl("button", { text: label, cls: primary ? "mod-cta" : "" }); button.onclick = () => void callback(); };
    if (!this.plugin.getDeviceCredential()) action("Connect this device", () => this.plugin.connectViaMultiUserEnrollment(), true);
    else if (!this.plugin.settings.initialSyncCompleted || !loadSyncState(this.plugin.syncStateScope())) {
      const resumed = Boolean(loadSyncTransaction(this.plugin.syncStateScope()));
      action(resumed ? "Resume vault sync" : "Set up vault sync", async () => { await this.plugin.resumeInitialSync(); await this.render(); }, true);
      action("Open calendar", () => this.plugin.openCalendar()); action("Refresh status", () => this.render());
    } else { action("Sync now", async () => { await this.plugin.syncVaultNow(); await this.render(); }, true); action("Open calendar", () => this.plugin.openCalendar()); action("Refresh status", () => this.render()); }
    if (data.profile) this.renderAccount(el, data.profile);
    await this.renderIssues(el, status);
  }
  async loadProfile() {
    if (!this.plugin.getDeviceCredential()) return { profile: null, connection: null };
    const [account, connection] = await Promise.allSettled([this.plugin.accountSummary(), this.plugin.checkNasConnection({ silent: true })]);
    return { profile: account.status === "fulfilled" ? account.value : null, connection: connection.status === "fulfilled" ? connection.value : null };
  }
  renderAccount(el, profile) {
    const current = profile.currentDevice || {}; el.createEl("h2", { text: "This device" });
    new Setting(el).setName(current.name || "Connected device").setDesc(`Account: ${profile.username}`).addButton(b => b.setButtonText("Rename").onClick(async () => { const name = window.prompt("New device name", current.name || ""); if (!name) return; try { await this.plugin.renameThisDevice(name); await this.render(); } catch (error) { new Notice(error.message || String(error)); } }));
    const devices = Array.isArray(profile.devices) ? profile.devices : [];
    new Setting(el)
      .setName("Devices on this account")
      .setDesc(`${devices.length} active ${devices.length === 1 ? "device" : "devices"}. Device names are unique within this account.`)
      .addButton(b => b.setButtonText("Manage devices").onClick(() => new DeviceManagerModal(this.app, this.plugin, () => this.render()).open()));
    new Setting(el).setName("Account").setDesc("Logging out removes this device’s local login only. Server content remains.").addButton(b => b.setButtonText("Log out").setWarning().onClick(async () => { if (!window.confirm("Log out from this device?")) return; await this.plugin.disconnectThisDevice(); await this.render(); }));
    new Setting(el).setName("Account data").setDesc("Export includes current files, immutable revisions, and quarantined deletions. Imports never overwrite existing files.").addButton(b => b.setButtonText("Export account").onClick(async () => { try { await this.plugin.exportAccountArchive(); } catch (error) { new Notice(error.message || String(error)); } })).addButton(b => b.setButtonText("Import account").onClick(() => {
      const input = document.createElement("input"); input.type = "file"; input.accept = ".zip,application/zip"; input.onchange = async () => { const file = input.files?.[0]; if (!file) return; try { const preview = await this.plugin.importAccountArchive(file, true); if (!window.confirm(`Import ${preview.wouldCreate?.length || 0} new files? Existing files will be skipped.`)) return; const result = await this.plugin.importAccountArchive(file, false); new Notice(`Imported ${result.created?.length || 0} files; skipped ${result.skipped?.length || 0}.`); await this.render(); } catch (error) { new Notice(error.message || String(error)); } }; input.click();
    })).addButton(b => b.setButtonText("Revision history").onClick(() => new HistoryModal(this.app, this.plugin).open()));
  }
  async renderIssues(el, status) {
    let protectedCopies = [];
    try { protectedCopies = await recoverableSetupCopies(this.plugin); } catch (_error) { /* Keep unresolved issues visible if the NAS cannot be checked. */ }
    const protectedPaths = new Set(protectedCopies.map(copy => copy.conflictPath));
    const issues = loadSyncIssues(this.plugin.syncStateScope()).filter(item => !item.reviewed && !protectedPaths.has(item.path) && !protectedPaths.has(item.conflictPath));
    if (protectedCopies.length) {
      el.createEl("h2", { text: "Protected setup copies" });
      el.createEl("p", { text: "These copies were protected while this new account had no matching server files. Restoring sends a new original copy to this account and keeps the protected copy for verification.", cls: "nas-vault-issues" });
      new Setting(el).setName(`${protectedCopies.length} recoverable ${protectedCopies.length === 1 ? "file" : "files"}`).setDesc("Each original path is absent both locally and on the NAS. Existing files are never overwritten.").addButton(b => b.setButtonText("Restore all to account").setCta().onClick(async () => {
        if (!window.confirm(`Restore ${protectedCopies.length} protected setup ${protectedCopies.length === 1 ? "copy" : "copies"} to this account? Each protected copy will be kept.`)) return;
        await this.plugin.recoverSetupCopies(protectedCopies); await this.render();
      }));
      for (const copy of protectedCopies) new Setting(el).setName(copy.originalPath).setDesc(`Protected file: ${copy.conflictPath}`).addButton(b => b.setButtonText("Restore to account").onClick(async () => {
        if (!window.confirm(`Restore ${copy.originalPath} to this account? The protected copy will be kept.`)) return;
        await this.plugin.recoverSetupCopies([copy]); await this.render();
      }));
    }
    el.createEl("h2", { text: "Needs attention" });
    if (!issues.length) { el.createEl("p", { text: protectedCopies.length ? "No active sync conflicts." : (status.tone === "green" ? "No action needed." : status.detail), cls: "nas-vault-issues" }); return; }
    for (const issue of issues) {
      const row = new Setting(el).setName(issue.kind === "conflict" ? `Conflict: ${issue.path || "file"}` : "Sync failed").setDesc(issue.detail);
      if (issue.kind === "conflict" && issue.remote?.revision) row.addButton(b => b.setButtonText("Compare / resolve").setCta().onClick(() => new ConflictModal(this.app, this.plugin, issue, () => this.render()).open()));
      row.addButton(b => b.setButtonText("Mark reviewed").onClick(async () => { markIssueReviewed(issue.id, this.plugin.syncStateScope()); await this.render(); }));
    }
    try {
      const deleted = await this.plugin.accountTrash();
      if (deleted.length) {
        el.createEl("h2", { text: "Deleted files (30-day restore)" });
        for (const item of deleted) new Setting(el).setName(item.path).setDesc(`Deleted ${new Date(item.acceptedAt).toLocaleString()} · expires ${new Date(item.purgeAt).toLocaleString()}`).addButton(b => b.setButtonText("Restore").onClick(async () => { try { await this.plugin.restoreDeletedRevision(item.revision); new Notice(`Restored ${item.path}`); await this.render(); } catch (error) { new Notice(error.message || String(error)); } }));
      }
    } catch (_error) { /* History is optional when the NAS is offline. */ }
  }
}

class DeviceManagerModal extends Modal {
  constructor(app, plugin, onChanged) { super(app); this.plugin = plugin; this.onChanged = onChanged; }
  async onOpen() { await this.refresh(); }
  async refresh() {
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "Devices on this account" });
    const status = el.createEl("p", { text: "Loading devices…", cls: "nas-vault-modal-status" });
    try {
      const value = await this.plugin.activeDevices();
      const devices = Array.isArray(value?.devices) ? value.devices : [];
      status.setText(devices.length ? "These devices can currently access this account." : "No active devices are registered.");
      for (const device of devices) {
        if (!device || typeof device.name !== "string") continue;
        const row = new Setting(el).setName(device.name).setDesc(device.name === this.plugin.settings.syncDeviceName ? `This device · ${formatLastSeen(device.lastSeenAt)}` : formatLastSeen(device.lastSeenAt));
        row.addButton((button) => button.setButtonText("Revoke").setWarning().setDisabled(device.name === this.plugin.settings.syncDeviceName).onClick(async () => {
          if (!window.confirm(`Revoke ${device.name}? Its access will stop immediately; account content is not deleted.`)) return;
          try { await this.plugin.revokeActiveDevice(device.name); await this.refresh(); if (this.onChanged) await this.onChanged(); }
          catch (error) { new Notice(error.message || String(error)); }
        }));
      }
    } catch (error) { status.setText(error.message || "Could not load devices."); }
  }
  onClose() { this.contentEl.empty(); }
}

function formatLastSeen(value) {
  if (!Number.isInteger(value) || value <= 0) return "Last contact unavailable.";
  return `Last online ${new Date(value * 1000).toLocaleString()}.`;
}
class ConflictModal extends Modal {
  constructor(app, plugin, issue, onDone) { super(app); this.plugin = plugin; this.issue = issue; this.onDone = onDone; }
  async onOpen() {
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: `Resolve conflict: ${this.issue.path}` });
    const status = el.createEl("p", { text: "Loading server revision…" });
    let remoteText = "(binary or unavailable)";
    try { const bytes = await this.plugin.revisionBytes(this.issue.remote.revision); const decoded = new TextDecoder().decode(bytes); if (!decoded.includes("\u0000")) remoteText = decoded; } catch (_error) { status.setText("The server revision is no longer available."); }
    status.setText("Local copy is preserved separately. Review both versions, then choose a resolution.");
    const grid = el.createDiv({ cls: "nas-vault-conflict-compare" });
    let localText = `(local copy unavailable)\n${this.issue.local?.sha256 || "unknown digest"}`;
    try { const bytes = await this.plugin.app.vault.adapter.readBinary(this.issue.path); const decoded = new TextDecoder().decode(bytes); if (!decoded.includes("\u0000")) localText = decoded; } catch (_error) { /* keep digest fallback */ }
    grid.createEl("pre", { text: `LOCAL\n${this.issue.path}\n\n${localText.slice(0, 12000)}` });
    grid.createEl("pre", { text: `SERVER REVISION\n${this.issue.remote.revision}\n\n${remoteText.slice(0, 12000)}` });
    const merged = el.createEl("textarea", { cls: "nas-vault-conflict-merge" }); merged.value = remoteText;
    const actions = el.createDiv({ cls: "nas-vault-actions" });
    const finish = async (choice) => { try { if (choice === "merge") { await this.plugin.app.vault.adapter.write(this.issue.path, merged.value); choice = "local"; } await this.plugin.resolveConflict(this.issue, choice); new Notice("Conflict resolved and revision recorded."); this.close(); this.onDone(); } catch (error) { new Notice(error.message || String(error)); } };
    for (const [label, choice] of [["Keep local", "local"], ["Keep server", "server"], ["Keep both", "both"], ["Save merged text", "merge"]]) { const b = actions.createEl("button", { text: label }); b.onclick = () => void finish(choice); }
  }
  onClose() { this.contentEl.empty(); }
}
class HistoryModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  async onOpen() {
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "Immutable revision history" });
    const status = el.createEl("p", { text: "Loading…" });
    try {
      const entries = await this.plugin.accountHistory(); status.setText(entries.length ? "Every accepted server revision is retained here." : "No revisions yet.");
      for (const item of entries.slice(0, 100)) new Setting(el).setName(item.path).setDesc(`${item.kind || "update"} · ${item.revision} · ${new Date(item.acceptedAt).toLocaleString()}`).addButton(b => b.setButtonText("Download").onClick(async () => { try { const bytes = await this.plugin.revisionBytes(item.revision); const safe = item.path.replace(/[^A-Za-z0-9_.-]+/g, "_"); const path = `.nas-vault-sync/revision-${item.revision}-${safe}`; await this.plugin.app.vault.adapter.mkdir(".nas-vault-sync").catch(() => undefined); await this.plugin.app.vault.adapter.writeBinary(path, bytes); new Notice(`Revision saved to ${path}`); } catch (error) { new Notice(error.message || String(error)); } }));
    } catch (error) { status.setText(error.message || "History unavailable while offline."); }
  }
  onClose() { this.contentEl.empty(); }
}
module.exports = { NasControlCenterView, CONTROL_CENTER_VIEW_TYPE, statusFor };
