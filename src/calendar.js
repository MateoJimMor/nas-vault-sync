"use strict";

const {
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
  normalizePath,
} = require("obsidian");

const { requestApi } = require("./api");
const { syncRequest, exportAccount, importAccount, history, trash, revisionContent, restoreRevision } = require("./sync-api");
const { initialServerSync, initialLocalImport, recoverSetupCopies, renameNow, resolveConflict } = require("./sync-engine");
const { syncNow } = require("./sync-engine");
const { loadSyncState, loadSyncTransaction } = require("./sync-state");
const { NasControlCenterView, CONTROL_CENTER_VIEW_TYPE } = require("./overview");
const { migrateNasBaseUrl, serviceBaseUrl } = require("./service-url");

const VIEW_TYPE = "nas-calendar-bridge-view";
const LEGACY_PLUGIN_ID = "nas-calendar-bridge";
// Legacy keys are read only during an explicit settings migration. New state is
// scoped to a local vault installation so two vaults on one desktop cannot
// overwrite each other's credentials or reconciliation state.
const LEGACY_TOKEN_STORAGE_KEY = "nas-calendar-bridge.api-token";
const LEGACY_SYNC_TOKEN_STORAGE_KEY = "nas-calendar-bridge.sync-token";
const DEVICE_CREDENTIAL_KEY = "mynasbridge.device-credential.v2";
const API_VERSION = 1;

const DEFAULT_SETTINGS = {
  nasBaseUrl: "",
  diaryRoot: "Daily",
  weekStartsMonday: true,
  syncDeviceName: "",
  autoInitialSyncAfterPairing: true,
  initialSyncCompleted: false,
  automaticVaultSync: false,
  automaticVaultSyncIntervalSeconds: 30,
};

class CalendarApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
  }
}

class NasCalendarBridge extends Plugin {
  async onload() {
    const currentData = await this.loadData();
    const legacyData = currentData ? undefined : await loadLegacySettings(this.app);
    const sourceData = currentData || legacyData || {};
    this.settings = migrateSettings(sourceData);
    this.localScope = localVaultScope(this.app);
    const hasLegacyUrl = ["apiBaseUrl", "syncApiBaseUrl", "enrollmentPortalUrl"]
      .some((key) => Object.prototype.hasOwnProperty.call(sourceData, key));
    if (!currentData || hasLegacyUrl || this.settings.nasBaseUrl !== sourceData.nasBaseUrl) await this.saveData(this.settings);
    this.registerView(VIEW_TYPE, (leaf) => new CalendarView(leaf, this));
    this.registerView(CONTROL_CENTER_VIEW_TYPE, (leaf) => new NasControlCenterView(leaf, this));

    this.addRibbonIcon("server", "Open NAS Vault", () => this.openNasControlCenter());
    this.addCommand({ id: "open-nas-overview", name: "Open NAS Vault", callback: () => this.openNasControlCenter() });
    this.addCommand({
      id: "open-calendar",
      name: "Open calendar",
      callback: () => this.openCalendar(),
    });
    this.addCommand({ id: "initial-server-vault-sync", name: "Initial server-authoritative vault sync", callback: () => this.initialServerSync() });
    this.addCommand({ id: "initial-local-vault-import", name: "Initial local vault import", callback: () => this.initialLocalImport() });
    this.addCommand({ id: "sync-vault-now", name: "Sync vault now", callback: () => this.syncVaultNow() });
    this.addCommand({ id: "test-vault-sync-connection", name: "Test vault-sync connection", callback: () => this.testSyncConnection() });
    this.addCommand({
      id: "refresh-calendar",
      name: "Refresh NAS calendar",
      callback: () => this.refreshViews(),
    });
    this.addCommand({
      id: "create-calendar-event",
      name: "Create calendar event",
      callback: () => new EventModal(this.app, this, null, localDateKey(new Date())).open(),
    });
    this.addCommand({
      id: "open-todays-daily-note",
      name: "Open today's daily note (server-routed)",
      callback: () => this.openDailyNote(localDateKey(new Date())),
    });

    this.addSettingTab(new CalendarBridgeSettingsTab(this.app, this));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshViews()));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void (async () => { const handled = await renameNow(this, oldPath, file.path).catch(() => false); if (!handled) this.scheduleVaultSync(); })();
    }));
    for (const event of ["modify", "create", "delete"]) this.registerEvent(this.app.vault.on(event, () => this.scheduleVaultSync()));
    if (typeof window !== "undefined" && typeof this.registerDomEvent === "function") {
      this.registerDomEvent(window, "focus", () => void this.syncOnResume());
      this.registerDomEvent(document, "visibilitychange", () => { if (!document.hidden) void this.syncOnResume(); });
      window.setTimeout(() => void this.syncOnResume(), 1200);
    }
    this.startVaultSyncPolling();
  }

  onunload() {
    this.stopVaultSyncPolling();
    if (this.vaultSyncTimer) window.clearTimeout(this.vaultSyncTimer);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(CONTROL_CENTER_VIEW_TYPE);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.refreshViews();
  }

  credentialStorageKey() { return `${DEVICE_CREDENTIAL_KEY}.${this.localScope}`; }
  syncStateScope() {
    const credential = this.getDeviceCredential();
    return credential ? `${this.localScope}.${localStateHash(credential)}` : this.localScope;
  }
  syncBaseUrl() { return serviceBaseUrl(this.settings.nasBaseUrl, "sync"); }
  getDeviceCredential() { try { return window.localStorage.getItem(this.credentialStorageKey()) || ""; } catch (_error) { return ""; } }
  setDeviceCredential(token) {
    try {
      if (token) window.localStorage.setItem(this.credentialStorageKey(), token);
      else window.localStorage.removeItem(this.credentialStorageKey());
    } catch (_error) { new Notice("Could not access this device's local credential storage."); }
  }
  // Compatibility aliases for the existing modules while all new flows use one grant.
  getToken() { return this.getDeviceCredential(); }
  getSyncToken() { return this.getDeviceCredential(); }
  setToken(token) { this.setDeviceCredential(token); }
  setSyncToken(token) { this.setDeviceCredential(token); }

  async apiRequest(path, method = "GET", body = undefined) {
    return requestApi(requestUrl, serviceBaseUrl(this.settings.nasBaseUrl, "calendar"), this.getToken(), path, method, body);
  }

  async getEvents(start, end) {
    const query = new URLSearchParams({ apiVersion: String(API_VERSION), start, end });
    const data = await this.apiRequest(`/v1/events?${query.toString()}`);
    if (!data || data.apiVersion !== API_VERSION || !Array.isArray(data.events)) {
      throw new CalendarApiError("Calendar API returned an unsupported response.");
    }
    return data.events;
  }

  async health() {
    return this.apiRequest(`/v1/health?apiVersion=${API_VERSION}`);
  }

  async syncHealth() {
    const response = await syncRequest(requestUrl, this.syncBaseUrl(), this.getDeviceCredential(), "/sync/v1/health");
    try { return JSON.parse(response.text); }
    catch (_error) { throw new Error("Vault sync health returned an invalid response."); }
  }

  async checkNasConnection(options = {}) {
    const [calendar, sync, heartbeat] = await Promise.allSettled([this.health(), this.syncHealth(), this.touchDevice()]);
    const result = {
      calendar: calendar.status === "fulfilled" && calendar.value?.status === "ok",
      sync: sync.status === "fulfilled" && sync.value?.status === "ok",
      device: heartbeat.status === "fulfilled" && heartbeat.value?.status === "ok",
    };
    if (!options.silent) new Notice(`NAS connection: calendar ${result.calendar ? "connected" : "unavailable"}; vault sync ${result.sync ? "connected" : "unavailable"}.`);
    return result;
  }

  async touchDevice() {
    return enrollmentRequest(serviceBaseUrl(this.settings.nasBaseUrl, "enrollment"), "/api/v2/device/heartbeat", "POST", {}, this.getDeviceCredential());
  }

  async activeDevices() {
    return enrollmentRequest(serviceBaseUrl(this.settings.nasBaseUrl, "enrollment"), "/api/v2/device/list-active", "POST", {}, this.getDeviceCredential());
  }

  async accountSummary() {
    return enrollmentRequest(serviceBaseUrl(this.settings.nasBaseUrl, "enrollment"), "/api/v2/account/me", "POST", {}, this.getDeviceCredential());
  }

  async renameThisDevice(name) {
    const result = await enrollmentRequest(serviceBaseUrl(this.settings.nasBaseUrl, "enrollment"), "/api/v2/device/rename-active", "POST", { deviceName: name }, this.getDeviceCredential());
    this.settings.syncDeviceName = result.deviceName;
    await this.saveSettings();
    return result;
  }

  async disconnectThisDevice() {
    this.setDeviceCredential("");
    this.settings.initialSyncCompleted = false;
    await this.saveSettings();
  }

  async openNasControlCenter() {
    let leaf = this.app.workspace.getLeavesOfType(CONTROL_CENTER_VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: CONTROL_CENTER_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async revokeActiveDevice(name) {
    return enrollmentRequest(serviceBaseUrl(this.settings.nasBaseUrl, "enrollment"), "/api/v2/device/revoke-active", "POST", { deviceName: name }, this.getDeviceCredential());
  }

  async testSyncConnection() {
    try {
      const health = await this.syncHealth();
      new Notice(`Vault sync healthy (contract v${health.apiVersion || "?"}).`);
      return health;
    } catch (error) {
      new Notice(error.message || String(error));
      throw error;
    }
  }

  async exportAccountArchive() {
    const bytes = await exportAccount(requestUrl, this.syncBaseUrl(), this.getDeviceCredential());
    const path = `.nas-vault-sync/account-export-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    await this.app.vault.adapter.mkdir(".nas-vault-sync").catch(() => undefined);
    await this.app.vault.adapter.writeBinary(path, bytes);
    new Notice(`Account export saved to ${path}. Keep it private.`);
    return path;
  }

  async importAccountArchive(file, dryRun = false) {
    const bytes = await file.arrayBuffer();
    const result = await importAccount(requestUrl, this.syncBaseUrl(), this.getDeviceCredential(), bytes, dryRun);
    return result;
  }

  async accountHistory(path) { return history(requestUrl, this.syncBaseUrl(), this.getDeviceCredential(), path); }
  async accountTrash() { return trash(requestUrl, this.syncBaseUrl(), this.getDeviceCredential()); }
  async restoreDeletedRevision(revision) { return restoreRevision(requestUrl, this.syncBaseUrl(), this.getDeviceCredential(), revision); }
  async revisionBytes(revision) { return revisionContent(requestUrl, this.syncBaseUrl(), this.getDeviceCredential(), revision); }
  async resolveConflict(issue, choice) {
    const result = await resolveConflict(this, issue, choice);
    const { loadSyncIssues, saveSyncIssues } = require("./sync-state");
    saveSyncIssues(loadSyncIssues(this.syncStateScope()).map(item => item.id === issue.id ? { ...item, reviewed: true } : item), this.syncStateScope());
    return result;
  }

  async connectViaMultiUserEnrollment() {
    let portal;
    try {
      portal = serviceBaseUrl(this.settings.nasBaseUrl, "enrollment");
    } catch (_error) {
      new Notice("Configure the private NAS base URL first.");
      return;
    }
    if (!this.settings.syncDeviceName.trim()) {
      new Notice("Choose this device's sync name first.");
      return;
    }
    try {
      const pairing = await enrollmentRequest(portal, "/api/v2/pairing/start", "POST", { deviceName: this.settings.syncDeviceName.trim() });
      if (pairing.apiVersion !== 2 || typeof pairing.pairingCode !== "string" || typeof pairing.pollToken !== "string") {
        throw new Error("Enrollment portal returned an incompatible response.");
      }
      new PortalEnrollmentModal(this.app, this, portal, pairing).open();
    } catch (error) {
      new Notice(error.message || String(error));
    }
  }

  async initialServerSync(options = {}) {
    if (this.vaultSyncRunning) return;
    if (options.confirm !== false && !window.confirm("Download the server vault now? Local files that differ will be preserved as conflict copies.")) return;
    this.vaultSyncRunning = true;
    try {
      const result = await initialServerSync(this);
      this.settings.initialSyncCompleted = true;
      await this.saveSettings();
      new Notice(`Vault sync complete: ${result.downloaded} downloaded, ${result.conflicts} conflicts preserved.`);
      return result;
    } catch (error) { new Notice(error.message || String(error)); }
    finally { this.vaultSyncRunning = false; }
  }

  async initialLocalImport() {
    if (this.vaultSyncRunning) return;
    this.vaultSyncRunning = true;
    try {
      const result = await initialLocalImport(this);
      this.settings.initialSyncCompleted = true;
      await this.saveSettings();
      new Notice(`Local vault imported: ${result.uploaded} uploaded, ${result.conflicts} existing server files preserved.`);
      return result;
    } catch (error) { new Notice(error.message || String(error)); }
    finally { this.vaultSyncRunning = false; }
  }

  async recoverSetupCopies(copies) {
    if (this.vaultSyncRunning) return;
    this.vaultSyncRunning = true;
    try {
      const result = await recoverSetupCopies(this, copies);
      this.settings.initialSyncCompleted = true;
      await this.saveSettings();
      new Notice(`Recovered ${result.restored} protected setup ${result.restored === 1 ? "copy" : "copies"} into this account. The protected copies remain for verification.`);
      return result;
    } catch (error) { new Notice(error.message || String(error)); }
    finally { this.vaultSyncRunning = false; }
  }

  async chooseInitialSync() {
    const importLocal = window.confirm("This is the first sync for this device. Press OK to import this device's shared vault into the new server account. Press Cancel to start from the server vault instead.");
    return importLocal ? this.initialLocalImport() : this.initialServerSync({ confirm: false });
  }

  async resumeInitialSync() {
    const transaction = loadSyncTransaction(this.syncStateScope());
    if (!transaction) return this.chooseInitialSync();
    if (transaction.mode === "initial-local") return this.initialLocalImport();
    return this.initialServerSync({ confirm: false });
  }

  async syncVaultNow(options = {}) {
    if (this.vaultSyncRunning) return;
    this.vaultSyncRunning = true;
    try {
      const result = await syncNow(this);
      if (!options.silent) new Notice(`Vault sync: ${result.downloaded} downloaded, ${result.uploaded} uploaded, ${result.deleted} deleted, ${result.conflicts} conflicts.`);
      return result;
    } catch (error) { if (!options.silent) new Notice(error.message || String(error)); }
    finally { this.vaultSyncRunning = false; }
  }

  async syncOnResume() {
    if (!this.settings.nasBaseUrl || !this.getDeviceCredential()) return;
    await this.checkNasConnection({ silent: true });
    if (this.settings.automaticVaultSync && loadSyncState(this.syncStateScope())) await this.syncVaultNow({ silent: true });
  }

  scheduleVaultSync() {
    if (!this.settings.automaticVaultSync || this.vaultSyncRunning || !loadSyncState(this.syncStateScope())) return;
    window.clearTimeout(this.vaultSyncTimer);
    this.vaultSyncTimer = window.setTimeout(() => this.syncVaultNow({ silent: true }), 3000);
  }

  startVaultSyncPolling() {
    this.stopVaultSyncPolling();
    if (!this.settings.automaticVaultSync || typeof window === "undefined") return;
    const seconds = Math.max(10, Math.min(3600, Number(this.settings.automaticVaultSyncIntervalSeconds) || 30));
    this.vaultSyncPollTimer = window.setInterval(() => {
      if (loadSyncState(this.syncStateScope())) void this.syncVaultNow({ silent: true });
    }, seconds * 1000);
  }

  stopVaultSyncPolling() {
    if (this.vaultSyncPollTimer && typeof window !== "undefined") window.clearInterval(this.vaultSyncPollTimer);
    this.vaultSyncPollTimer = undefined;
  }

  async ensureDailyNote(date) {
    return this.apiRequest(`/v1/daily-notes/${encodeURIComponent(date)}/ensure`, "POST", {
      apiVersion: API_VERSION,
      diaryRoot: this.settings.diaryRoot,
    });
  }

  async createEvent(event) {
    const data = await this.apiRequest("/v1/events", "POST", {
      apiVersion: API_VERSION,
      event,
    });
    return data.event;
  }

  async updateEvent(id, event) {
    const data = await this.apiRequest(`/v1/events/${encodeURIComponent(id)}`, "PUT", {
      apiVersion: API_VERSION,
      event,
    });
    return data.event;
  }

  async deleteEvent(id) {
    return this.apiRequest(`/v1/events/${encodeURIComponent(id)}`, "DELETE", {
      apiVersion: API_VERSION,
    });
  }

  async openCalendar() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && typeof leaf.view.refresh === "function") await leaf.view.refresh();
    }
  }

  dailyNotePath(date) {
    const year = date.slice(0, 4);
    const month = date.slice(0, 7);
    return normalizePath(`${this.settings.diaryRoot}/${year}/${month}/${date}.md`);
  }

  async openDailyNote(date) {
    const path = this.dailyNotePath(date);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      await this.app.workspace.openLinkText(path, "", false);
      return;
    }

    try {
      const result = await this.ensureDailyNote(date);
      new Notice(result?.created ? `Requested daily note for ${date}.` : `Daily note already exists for ${date}.`);
      await waitForVaultFile(this.app, path, 15000);
      const created = this.app.vault.getAbstractFileByPath(path);
      if (created) await this.app.workspace.openLinkText(path, "", false);
      else new Notice("The server accepted the request, but Syncthing has not delivered the note yet.");
    } catch (error) {
      new Notice(error.message || String(error));
    }
  }
}

class CalendarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    const today = new Date();
    this.month = new Date(today.getFullYear(), today.getMonth(), 1);
    this.selectedDate = localDateKey(today);
    this.events = [];
    this.loading = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "NAS Calendar";
  }

  getIcon() {
    return "calendar-days";
  }

  async onOpen() {
    await this.refresh();
  }

  async onClose() {
    this.contentEl.empty();
  }

  async refresh() {
    if (!this.contentEl) return;
    this.loading = true;
    this.render();
    try {
      const range = monthRange(this.month);
      this.events = await this.plugin.getEvents(range.start, range.end);
      this.render();
    } catch (error) {
      this.events = [];
      this.render(error.message || String(error));
    } finally {
      this.loading = false;
    }
  }

  render(errorMessage = "") {
    this.contentEl.empty();
    this.contentEl.addClass("nas-calendar-bridge");

    const toolbar = this.contentEl.createDiv({ cls: "nas-calendar-bridge__toolbar" });
    const navigation = toolbar.createDiv({ cls: "nas-calendar-bridge__toolbar-group" });
    button(navigation, "‹", "Previous month", () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() - 1, 1);
      this.refresh();
    });
    button(navigation, "Today", "Go to today", () => {
      const today = new Date();
      this.month = new Date(today.getFullYear(), today.getMonth(), 1);
      this.selectedDate = localDateKey(today);
      this.refresh();
    });
    button(navigation, "›", "Next month", () => {
      this.month = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 1);
      this.refresh();
    });

    const monthLabel = toolbar.createDiv({ cls: "nas-calendar-bridge__month" });
    monthLabel.setText(this.month.toLocaleDateString(undefined, { month: "long", year: "numeric" }));

    const actions = toolbar.createDiv({ cls: "nas-calendar-bridge__toolbar-group" });
    button(actions, "Refresh", "Refresh events", () => this.refresh());
    button(actions, "+ Event", "Create event", () => {
      new EventModal(this.plugin.app, this.plugin, null, this.selectedDate).open();
    });

    const status = this.contentEl.createDiv({ cls: "nas-calendar-bridge__status" });
    if (this.loading) status.setText("Loading events…");
    if (errorMessage) {
      status.addClass("is-error");
      status.setText(errorMessage);
    }

    const weekdays = this.contentEl.createDiv({ cls: "nas-calendar-bridge__weekdays" });
    const weekdayNames = this.plugin.settings.weekStartsMonday
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (const name of weekdayNames) weekdays.createDiv({ cls: "nas-calendar-bridge__weekday", text: name });

    const grid = this.contentEl.createDiv({ cls: "nas-calendar-bridge__grid" });
    for (const date of calendarDates(this.month, this.plugin.settings.weekStartsMonday)) {
      const dateKey = localDateKey(date);
      const day = grid.createDiv({ cls: "nas-calendar-bridge__day" });
      day.setAttribute("role", "button");
      day.tabIndex = 0;
      day.setAttribute("aria-label", `Open daily note for ${dateKey}`);
      if (date.getMonth() !== this.month.getMonth()) day.addClass("is-outside-month");
      if (dateKey === localDateKey(new Date())) day.addClass("is-today");
      if (dateKey === this.selectedDate) day.addClass("is-selected");
      day.addEventListener("click", () => {
        this.selectedDate = dateKey;
        this.plugin.openDailyNote(dateKey);
      });
      day.addEventListener("keydown", (keyboardEvent) => {
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          this.selectedDate = dateKey;
          this.plugin.openDailyNote(dateKey);
        }
      });

      day.createDiv({ cls: "nas-calendar-bridge__day-number", text: String(date.getDate()) });
      const events = this.events.filter((event) => eventDateKey(event) === dateKey);
      for (const event of events) {
        const eventButton = day.createEl("button", { cls: "nas-calendar-bridge__event" });
        eventButton.type = "button";
        eventButton.style.borderLeftColor = safeColor(event.color);
        eventButton.setAttribute("title", event.description || event.title || "Event");
        eventButton.addEventListener("click", (click) => {
          click.stopPropagation();
          new EventModal(this.plugin.app, this.plugin, event, dateKey).open();
        });
        const time = event.allDay ? "All day" : formatEventTime(event.start);
        eventButton.createSpan({ cls: "nas-calendar-bridge__event-time", text: `${time} ` });
        eventButton.createSpan({ text: event.title || "Untitled event" });
      }
    }
  }
}

class EventModal extends Modal {
  constructor(app, plugin, event, defaultDate) {
    super(app);
    this.plugin = plugin;
    this.event = event;
    this.defaultDate = defaultDate;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.event ? "Edit event" : "Create event" });

    const start = splitDateTime(this.event?.start, this.defaultDate);
    const end = splitDateTime(this.event?.end, start.date);
    const fields = {};

    fields.title = textSetting(contentEl, "Title", "Event title", this.event?.title || "");
    fields.allDay = checkboxSetting(contentEl, "All day", this.event?.allDay ?? false);
    fields.startDate = textSetting(contentEl, "Start date", "YYYY-MM-DD", start.date);
    fields.startTime = textSetting(contentEl, "Start time", "HH:MM", start.time);
    fields.endDate = textSetting(contentEl, "End date", "YYYY-MM-DD", end.date);
    fields.endTime = textSetting(contentEl, "End time", "HH:MM", end.time);
    fields.topic = textSetting(contentEl, "Topic", "Optional category", this.event?.topic || "");
    fields.color = textSetting(contentEl, "Color", "#7c3aed", this.event?.color || "#7c3aed");
    fields.location = textSetting(contentEl, "Location", "Optional", this.event?.location || "");
    fields.url = textSetting(contentEl, "Link", "https://…", this.event?.url || "");
    fields.recurrence = textSetting(contentEl, "Recurrence", "RRULE:FREQ=WEEKLY (optional)", (this.event?.recurrence || [])[0] || "");
    fields.reminders = textSetting(contentEl, "Email reminders", "Minutes before, comma-separated", (this.event?.reminders || [])
      .filter((reminder) => reminder.method === "email")
      .map((reminder) => reminder.minutesBefore)
      .join(", "));
    fields.attendees = textSetting(contentEl, "Attendees", "Email addresses, comma-separated", (this.event?.attendees || []).join(", "));

    const descriptionSetting = new Setting(contentEl).setName("Description");
    fields.description = descriptionSetting.controlEl.createEl("textarea");
    fields.description.rows = 4;
    fields.description.value = this.event?.description || "";
    fields.description.placeholder = "Optional description";

    const hint = contentEl.createDiv({ cls: "nas-calendar-bridge__form-description" });
    hint.setText("Events are stored by the authenticated NAS calendar backend. Tasks remain Markdown checkboxes.");

    const actions = contentEl.createDiv({ cls: "nas-calendar-bridge__event-actions" });
    if (this.event) {
      button(actions, "Delete", "Delete event", async () => {
        if (!window.confirm("Delete this event from the canonical calendar?")) return;
        try {
          await this.plugin.deleteEvent(this.event.id || this.event.uid);
          this.close();
          new Notice("Event deleted.");
          await this.plugin.refreshViews();
        } catch (error) {
          new Notice(error.message || String(error));
        }
      });
    }
    button(actions, "Cancel", "Cancel", () => this.close());
    button(actions, this.event ? "Save" : "Create", "Save event", async () => {
      const title = fields.title.value.trim();
      if (!title) {
        new Notice("An event title is required.");
        return;
      }
      const allDay = fields.allDay.checked;
      const startDate = fields.startDate.value.trim();
      const endDate = fields.endDate.value.trim() || startDate;
      const startTime = fields.startTime.value.trim() || "09:00";
      const endTime = fields.endTime.value.trim() || "10:00";
      const recurrence = fields.recurrence.value.trim();
      const reminders = fields.reminders.value
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((minutesBefore) => ({ method: "email", minutesBefore }));
      const attendees = fields.attendees.value
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const event = {
        title,
        allDay,
        start: allDay ? startDate : `${startDate}T${startTime}`,
        end: allDay ? endDate : `${endDate}T${endTime}`,
        topic: fields.topic.value.trim(),
        color: fields.color.value.trim() || "#7c3aed",
        location: fields.location.value.trim(),
        url: fields.url.value.trim(),
        description: fields.description.value.trim(),
        recurrence: recurrence ? [recurrence] : [],
        reminders,
        attendees,
      };
      try {
        if (this.event) await this.plugin.updateEvent(this.event.id || this.event.uid, event);
        else await this.plugin.createEvent(event);
        this.close();
        new Notice(this.event ? "Event updated." : "Event created.");
        await this.plugin.refreshViews();
      } catch (error) {
        new Notice(error.message || String(error));
      }
    });
  }
}

class CalendarBridgeSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "NAS Vault settings" });
    containerEl.createEl("p", {
      text: "Use one private NAS base URL. Calendar, vault sync, and enrollment are routed internally by the NAS gateway.",
    });

    new Setting(containerEl)
      .setName("NAS base URL")
      .setDesc("Use the private Tailscale address of the NAS, without a service path, credentials, query, or fragment.")
      .addText((text) => text
        .setPlaceholder("https://nas.example")
        .setValue(this.plugin.settings.nasBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.nasBaseUrl = migrateNasBaseUrl(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Daily note root")
      .setDesc("Vault-relative folder containing the canonical diary tree.")
      .addText((text) => text
        .setValue(this.plugin.settings.diaryRoot)
        .onChange(async (value) => {
          this.plugin.settings.diaryRoot = value.trim() || DEFAULT_SETTINGS.diaryRoot;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Week starts on Monday")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.weekStartsMonday)
        .onChange(async (value) => {
          this.plugin.settings.weekStartsMonday = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown only to this account. Active device names must be unique within the account.")
      .addText((text) => text.setPlaceholder("Phone").setValue(this.plugin.settings.syncDeviceName).onChange(async (value) => { this.plugin.settings.syncDeviceName = value.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Connect to NAS")
      .setDesc("Register a new account or sign in and connect this device. The NAS stores its credential locally.")
      .addButton((button) => button.setButtonText("Connect to NAS").onClick(() => this.plugin.connectViaMultiUserEnrollment()));

    new Setting(containerEl)
      .setName("Initial sync after connecting")
      .setDesc("After a new device connects, asks whether to import this vault into the account or begin from the account's server vault.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoInitialSyncAfterPairing !== false).onChange(async (value) => { this.plugin.settings.autoInitialSyncAfterPairing = value; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Automatic vault sync")
      .setDesc("Checks and syncs when Obsidian opens or resumes, and after local changes. Enable only after Syncthing is stopped for this vault.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.automaticVaultSync).onChange(async (value) => { this.plugin.settings.automaticVaultSync = value; await this.plugin.saveSettings(); this.plugin.startVaultSyncPolling(); }));

    new Setting(containerEl)
      .setName("Automatic sync poll interval (seconds)")
      .setDesc("Checks the NAS for remote changes while Obsidian is open. Minimum 10 seconds; mobile background execution is not guaranteed.")
      .addText((text) => { text.inputEl.type = "number"; text.setValue(String(this.plugin.settings.automaticVaultSyncIntervalSeconds || 30)); text.onChange(async (value) => { const seconds = Math.max(10, Math.min(3600, Number(value) || 30)); this.plugin.settings.automaticVaultSyncIntervalSeconds = seconds; text.setValue(String(seconds)); await this.plugin.saveSettings(); this.plugin.startVaultSyncPolling(); }); });

    new Setting(containerEl)
      .setName("Sync vault now")
      .setDesc("Runs a manual three-way synchronization after the first-sync baseline has been established.")
      .addButton((button) => button.setButtonText("Sync now").onClick(() => this.plugin.syncVaultNow()));

  }
}

class PortalEnrollmentModal extends Modal {
  constructor(app, plugin, portal, pairing) {
    super(app);
    this.plugin = plugin;
    this.portal = portal;
    this.pairing = pairing;
    this.timer = null;
    this.pollInFlight = false;
  }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: "Continue in NAS Vault" });
    el.createEl("p", { text: "The private NAS page lets you sign in or register. It will authorize this device after email verification; the device credential is never displayed." });
    const status = el.createEl("p", { text: "Opening the private NAS page…" });
    const open = el.createEl("button", { text: "Open NAS Vault" });
    open.addEventListener("click", () => this.openPortal());
    this.openPortal();
    this.timer = window.setInterval(async () => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const value = await enrollmentRequest(this.portal, `/api/v2/pairing/poll?token=${encodeURIComponent(this.pairing.pollToken)}`);
        if (value.status === "complete") {
          window.clearInterval(this.timer);
          if (value.apiVersion !== 2 || typeof value.token !== "string") throw new Error("Enrollment portal returned an incompatible response.");
          this.plugin.setDeviceCredential(value.token);
          this.plugin.settings.initialSyncCompleted = false;
          await this.plugin.saveSettings();
          if (this.plugin.settings.autoInitialSyncAfterPairing !== false && !loadSyncState(this.plugin.syncStateScope())) {
            status.setText("Device connected. Choose how to establish the first vault baseline…");
            const result = await this.plugin.chooseInitialSync();
            if (result) {
              status.setText(`Device connected and initial sync complete (${result.downloaded} downloaded, ${result.conflicts} conflicts preserved).`);
              new Notice("NAS device connection and initial vault sync complete.");
            } else status.setText("Device connected, but the initial sync did not complete. Run Sync vault now to retry.");
          } else {
            status.setText("Device connected. You can close this window.");
            new Notice("NAS device connection complete.");
          }
        }
      } catch (error) {
        window.clearInterval(this.timer);
        status.setText(error.message || String(error));
      } finally {
        this.pollInFlight = false;
      }
    }, 2500);
  }

  openPortal() {
    const url = new URL(this.portal);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    url.searchParams.set("pairing", this.pairing.pairingCode);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  onClose() {
    if (this.timer) window.clearInterval(this.timer);
    this.contentEl.empty();
  }
}

async function loadLegacySettings(app) {
  const adapter = app?.vault?.adapter;
  if (!adapter || typeof adapter.read !== "function") return undefined;
  try {
    const configDir = app.vault.configDir || ".obsidian";
    const path = normalizePath(configDir + "/plugins/" + LEGACY_PLUGIN_ID + "/data.json");
    const value = JSON.parse(await adapter.read(path));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

function migrateSettings(value) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, value || {});
  settings.nasBaseUrl = migrateNasBaseUrl(settings.nasBaseUrl, value || {});
  delete settings.apiBaseUrl;
  delete settings.syncApiBaseUrl;
  delete settings.enrollmentPortalUrl;
  delete settings.calendarId;
  return settings;
}

function localVaultScope(app) {
  const value = String(app?.vault?.adapter?.basePath || app?.vault?.getName?.() || "default");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function localStateHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function enrollmentRequest(base, path, method = "GET", body = undefined, credential = "") {
  let url;
  try {
    const parsed = new URL(base.trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    url = base.trim().replace(/\/$/, "") + path;
  } catch (_error) {
    throw new Error("Configure a valid private NAS base URL.");
  }
  const response = await requestUrl({
    url,
    method,
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    throw: false,
  });
  let value;
  try { value = JSON.parse(response.text); } catch (_error) { throw new Error("Enrollment portal returned an invalid response."); }
  if (response.status < 200 || response.status >= 300) throw new Error(value.message || `Enrollment failed (HTTP ${response.status}).`);
  return value;
}

function textSetting(parent, name, placeholder, value) {
  const setting = new Setting(parent).setName(name);
  const input = setting.controlEl.createEl("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function checkboxSetting(parent, name, value) {
  const setting = new Setting(parent).setName(name);
  const input = setting.controlEl.createEl("input");
  input.type = "checkbox";
  input.checked = value;
  return input;
}

function button(parent, label, ariaLabel, onClick) {
  const element = parent.createEl("button", { text: label });
  element.type = "button";
  element.setAttribute("aria-label", ariaLabel);
  element.addEventListener("click", onClick);
  return element;
}

function localDateKey(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return new Date(NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function calendarDates(month, mondayFirst) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const firstDay = mondayFirst ? (first.getDay() + 6) % 7 : first.getDay();
  const total = Math.ceil((firstDay + last.getDate()) / 7) * 7;
  const start = new Date(first);
  start.setDate(first.getDate() - firstDay);
  return Array.from({ length: total }, (_unused, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function monthRange(month) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  return { start: localDateKey(start), end: localDateKey(end) };
}

function eventDateKey(event) {
  if (!event || typeof event.start !== "string") return "";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(event.start)) return event.start.slice(0, 10);
  return localDateKey(new Date(event.start));
}

function formatEventTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16) || value;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function splitDateTime(value, fallbackDate) {
  if (typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(value)) {
    return { date: value.slice(0, 10), time: value.length >= 16 ? value.slice(11, 16) : "09:00" };
  }
  return { date: fallbackDate, time: "09:00" };
}

function safeColor(value) {
  if (typeof value !== "string") return "var(--interactive-accent)";
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (/^rgba?\([0-9., %]+\)$/.test(value)) return value;
  return "var(--interactive-accent)";
}

async function waitForVaultFile(app, path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (app.vault.getAbstractFileByPath(path)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  return false;
}

module.exports = NasCalendarBridge;
