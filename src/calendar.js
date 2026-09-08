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
const { syncRequest } = require("./sync-api");
const { initialServerSync } = require("./sync-engine");
const { syncNow } = require("./sync-engine");
const { NasOverview } = require("./overview");

const VIEW_TYPE = "nas-calendar-bridge-view";
const TOKEN_STORAGE_KEY = "nas-calendar-bridge.api-token";
const SYNC_TOKEN_STORAGE_KEY = "nas-calendar-bridge.sync-token";
const API_VERSION = 1;

const DEFAULT_SETTINGS = {
  apiBaseUrl: "",
  calendarId: "personal",
  diaryRoot: "Daily",
  weekStartsMonday: true,
  syncApiBaseUrl: "",
  syncDeviceName: "",
  enrollmentPortalUrl: "",
  automaticVaultSync: false,
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new CalendarView(leaf, this));

    this.addRibbonIcon("server", "Open NAS overview", () => new NasOverview(this.app, this).open());
    this.addCommand({ id: "open-nas-overview", name: "Open NAS overview", callback: () => new NasOverview(this.app, this).open() });
    this.addRibbonIcon("calendar-days", "Open NAS calendar", () => this.openCalendar());
    this.addCommand({
      id: "open-calendar",
      name: "Open calendar",
      callback: () => this.openCalendar(),
    });
    this.addCommand({ id: "initial-server-vault-sync", name: "Initial server-authoritative vault sync", callback: () => this.initialServerSync() });
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
    for (const event of ["modify", "create", "delete", "rename"]) this.registerEvent(this.app.vault.on(event, () => this.scheduleVaultSync()));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.refreshViews();
  }

  getToken() {
    try {
      return window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
    } catch (_error) {
      return "";
    }
  }

  setToken(token) {
    try {
      if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
      else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (_error) {
      new Notice("Could not access local token storage.");
    }
  }

  getSyncToken() { try { return window.localStorage.getItem(SYNC_TOKEN_STORAGE_KEY) || ""; } catch (_error) { return ""; } }
  setSyncToken(token) { try { if (token) window.localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, token); else window.localStorage.removeItem(SYNC_TOKEN_STORAGE_KEY); } catch (_error) { new Notice("Could not access local token storage."); } }

  async apiRequest(path, method = "GET", body = undefined) {
    return requestApi(requestUrl, this.settings.apiBaseUrl, this.getToken(), path, method, body);
  }

  async getEvents(start, end) {
    const query = new URLSearchParams({
      apiVersion: String(API_VERSION),
      calendarId: this.settings.calendarId,
      start,
      end,
    });
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
    return syncRequest(requestUrl, this.settings.syncApiBaseUrl, this.getSyncToken(), "/sync/v1/health");
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

  async connectViaEnrollment() {
    const portal = this.settings.enrollmentPortalUrl.trim();
    if (!portal) {
      new Notice("Configure the private enrollment portal URL first.");
      return;
    }
    if (!this.settings.syncDeviceName.trim()) {
      new Notice("Choose this device's sync name first.");
      return;
    }
    try {
      const value = await enrollmentRequest(portal, "/api/v1/pairing/start", "POST", {
        deviceName: this.settings.syncDeviceName.trim(),
      });
      if (!value || value.apiVersion !== API_VERSION || typeof value.pairingCode !== "string" || typeof value.pollToken !== "string") {
        throw new Error("Enrollment portal returned an incompatible pairing response.");
      }
      new EnrollmentModal(this.app, this, portal, value).open();
    } catch (error) {
      new Notice(error.message || String(error));
    }
  }

  async initialServerSync() {
    if (this.vaultSyncRunning) return;
    if (!window.confirm("Download the server vault now? Local files that differ will be preserved as conflict copies.")) return;
    this.vaultSyncRunning = true;
    try {
      const result = await initialServerSync(this);
      new Notice(`Vault sync complete: ${result.downloaded} downloaded, ${result.conflicts} conflicts preserved.`);
    } catch (error) { new Notice(error.message || String(error)); }
    finally { this.vaultSyncRunning = false; }
  }

  async syncVaultNow() {
    if (this.vaultSyncRunning) return;
    this.vaultSyncRunning = true;
    try {
      const result = await syncNow(this);
      new Notice(`Vault sync: ${result.downloaded} downloaded, ${result.uploaded} uploaded, ${result.deleted} deleted, ${result.conflicts} conflicts.`);
    } catch (error) { new Notice(error.message || String(error)); }
    finally { this.vaultSyncRunning = false; }
  }

  scheduleVaultSync() {
    if (!this.settings.automaticVaultSync || this.vaultSyncRunning) return;
    window.clearTimeout(this.vaultSyncTimer);
    this.vaultSyncTimer = window.setTimeout(() => this.syncVaultNow(), 3000);
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
      calendarId: this.settings.calendarId,
      event,
    });
    return data.event;
  }

  async updateEvent(id, event) {
    const data = await this.apiRequest(`/v1/events/${encodeURIComponent(id)}`, "PUT", {
      apiVersion: API_VERSION,
      calendarId: this.settings.calendarId,
      event,
    });
    return data.event;
  }

  async deleteEvent(id) {
    return this.apiRequest(`/v1/events/${encodeURIComponent(id)}`, "DELETE", {
      apiVersion: API_VERSION,
      calendarId: this.settings.calendarId,
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
    containerEl.createEl("h2", { text: "NAS Vault — Calendar settings" });
    containerEl.createEl("p", {
      text: "The API URL points to your self-hosted bridge. It must expose this plugin's compatible API contract.",
    });

    new Setting(containerEl)
      .setName("Calendar API URL")
      .setDesc("Use the private address of your compatible calendar service.")
      .addText((text) => text
        .setPlaceholder("https://…")
        .setValue(this.plugin.settings.apiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Calendar ID")
      .setDesc("The canonical calendar identifier on the NAS backend.")
      .addText((text) => text
        .setValue(this.plugin.settings.calendarId)
        .onChange(async (value) => {
          this.plugin.settings.calendarId = value.trim() || DEFAULT_SETTINGS.calendarId;
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
      .setName("Vault Sync API URL")
      .setDesc("Use the private address of your compatible sync service. Complete the initial sync before ordinary synchronization.")
      .addText((text) => text.setPlaceholder("https://sync.example.com/vault-sync").setValue(this.plugin.settings.syncApiBaseUrl).onChange(async (value) => { this.plugin.settings.syncApiBaseUrl = value.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Private enrollment portal URL")
      .setDesc("Optional: the private Tailscale address of the NAS pairing page. It never contains a permanent token.")
      .addText((text) => text.setPlaceholder("https://nas.example/enroll").setValue(this.plugin.settings.enrollmentPortalUrl).onChange(async (value) => { this.plugin.settings.enrollmentPortalUrl = value.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("This device's sync name")
      .setDesc("Used only in preserved conflict filenames.")
      .addText((text) => text.setPlaceholder("Phone").setValue(this.plugin.settings.syncDeviceName).onChange(async (value) => { this.plugin.settings.syncDeviceName = value.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Connect to NAS")
      .setDesc("Starts a short-lived pairing code. Approve it on the private enrollment page; the device token is stored locally only.")
      .addButton((button) => button.setButtonText("Pair device").onClick(() => this.plugin.connectViaEnrollment()));

    new Setting(containerEl)
      .setName("Automatic vault sync")
      .setDesc("Syncs while Obsidian is open after local changes. Enable only after Syncthing is stopped for this vault.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.automaticVaultSync).onChange(async (value) => { this.plugin.settings.automaticVaultSync = value; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Sync vault now")
      .setDesc("Runs a manual three-way synchronization. The first run is server-authoritative and preserves local conflicts.")
      .addButton((button) => button.setButtonText("Sync now").onClick(() => this.plugin.syncVaultNow()));

    new Setting(containerEl)
      .setName("API token")
      .setDesc("Stored only in this device's local storage; it is not written to the synced vault.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Bearer token").setValue(this.plugin.getToken());
        text.onChange((value) => this.plugin.setToken(value.trim()));
      });

    new Setting(containerEl)
      .setName("Vault Sync token")
      .setDesc("A distinct device-local credential. It is never written to the synced vault.")
      .addText((text) => { text.inputEl.type = "password"; text.setPlaceholder("Device token").setValue(this.plugin.getSyncToken()); text.onChange((value) => this.plugin.setSyncToken(value.trim())); });

    new Setting(containerEl)
      .setName("Test Calendar connection")
      .setDesc("Checks the authenticated health endpoint without changing calendar data.")
      .addButton((buttonEl) => buttonEl.setButtonText("Test").onClick(async () => {
        try {
          const health = await this.plugin.health();
          new Notice(`Calendar API healthy (contract v${health.apiVersion || "?"}).`);
        } catch (error) {
          new Notice(error.message || String(error));
        }
      }));

    new Setting(containerEl)
      .setName("Test Vault Sync connection")
      .setDesc("Checks the authenticated vault-sync health endpoint without changing files.")
      .addButton((buttonEl) => buttonEl.setButtonText("Test").onClick(() => this.plugin.testSyncConnection()));
  }
}

class EnrollmentModal extends Modal {
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
    el.createEl("h2", { text: "Connect this device to NAS" });
    el.createEl("p", { text: "Approve this one-time code on the private enrollment page. No permanent credential is shown here." });
    const code = el.createEl("code", { text: this.pairing.pairingCode });
    code.setAttr("aria-label", "One-time pairing code");
    const status = el.createEl("p", { text: "Waiting for approval…" });
    const open = el.createEl("button", { text: "Open enrollment page" });
    open.addEventListener("click", () => {
      const url = new URL(this.portal);
      url.searchParams.set("code", this.pairing.pairingCode);
      window.open(url.toString(), "_blank");
    });
    this.timer = window.setInterval(async () => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const value = await enrollmentRequest(this.portal, `/api/v1/pairing/poll?token=${encodeURIComponent(this.pairing.pollToken)}`);
        if (value.status === "complete") {
          window.clearInterval(this.timer);
          this.plugin.settings.syncApiBaseUrl = value.apiBaseUrl;
          this.plugin.settings.syncDeviceName = value.deviceName;
          this.plugin.setSyncToken(value.token);
          await this.plugin.saveSettings();
          status.setText("Device approved and configured. You can close this window.");
          new Notice("NAS device pairing complete. Test the vault-sync connection before syncing.");
        }
      } catch (error) {
        window.clearInterval(this.timer);
        status.setText(error.message || String(error));
      } finally {
        this.pollInFlight = false;
      }
    }, 2500);
  }

  onClose() {
    if (this.timer) window.clearInterval(this.timer);
    this.contentEl.empty();
  }
}

async function enrollmentRequest(base, path, method = "GET", body = undefined) {
  let url;
  try {
    const parsed = new URL(base.trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    url = base.trim().replace(/\/$/, "") + path;
  } catch (_error) {
    throw new Error("Configure a valid private enrollment portal URL.");
  }
  const response = await requestUrl({
    url,
    method,
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
