export type VaultPathScope = "shared" | "device-local" | "user-reviewed";

export interface VaultPathClassification {
  scope: VaultPathScope;
  reason: string;
}

const DEVICE_LOCAL_PATHS = new Set([
  ".obsidian/app.json",
  ".obsidian/appearance.json",
  ".obsidian/hotkeys.json",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
]);

const DEVICE_LOCAL_PREFIXES = [
  ".obsidian/cache/",
  ".obsidian/workspace/",
  ".trash/",
];

/**
 * Classifies a vault-relative path for display and future sync planning only.
 * It does not authorize a transfer or change any file.
 */
export function classifyVaultPath(path: string): VaultPathClassification {
  if (!isSafeRelativePath(path)) {
    return { scope: "user-reviewed", reason: "The path is not a safe vault-relative path." };
  }
  if (DEVICE_LOCAL_PATHS.has(path) || DEVICE_LOCAL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { scope: "device-local", reason: "Obsidian workspace, cache, appearance, or trash state is device-local." };
  }
  if (path === ".obsidian" || path.startsWith(".obsidian/")) {
    return { scope: "user-reviewed", reason: "Obsidian configuration and plugin resources require an explicit compatibility review." };
  }
  if (path === ".git" || path.startsWith(".git/")) {
    return { scope: "user-reviewed", reason: "Git metadata must not be handled by a vault synchronization protocol." };
  }
  if (path.includes(".conflict-")) {
    return { scope: "user-reviewed", reason: "Conflict copies stay on the affected device until reviewed." };
  }
  return { scope: "shared", reason: "User content is eligible for the future shared-content policy." };
}

export function scopeSummary(): readonly string[] {
  return [
    "Shared: Markdown and attachments outside protected application-state folders.",
    "Device-local: workspace, cache, appearance, hotkey, and trash state.",
    "User-reviewed: .obsidian plugin/configuration resources and Git metadata.",
  ];
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.split("/").some((segment) => !segment || segment === "." || segment === "..");
}
