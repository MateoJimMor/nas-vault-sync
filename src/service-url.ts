export type NasService = "calendar" | "sync" | "enrollment";

/**
 * User-facing configuration contains only the private NAS base URL. These
 * service paths are an internal gateway contract and are not settings.
 */
export const SERVICE_PATHS: Record<NasService, string> = {
  calendar: "/calendar-api",
  sync: "/vault-sync",
  enrollment: "/vault-enroll",
};

const LEGACY_SERVICE_SUFFIXES = [
  "/calendar-api",
  "/vault-sync",
  "/vault-sync-pilot",
  "/vault-enroll",
  "/vault-enroll-pilot",
  "/enrollment",
];

function parsePrivateBaseUrl(value: string): URL {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Configure a valid private NAS base URL.");
  }
  if (!trimmed || !["http:", "https:"].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Use an HTTP or HTTPS NAS base URL without credentials, query, or fragment.");
  }
  return parsed;
}

function formatBaseUrl(parsed: URL): string {
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path === "/" ? "" : path}`;
}

export function normalizeNasBaseUrl(value: string): string {
  return formatBaseUrl(parsePrivateBaseUrl(value));
}

export function serviceBaseUrl(base: string, service: NasService): string {
  const path = SERVICE_PATHS[service];
  if (!path) throw new Error("Unknown NAS service.");
  return normalizeNasBaseUrl(base) + path;
}

/** Convert a former service-specific URL into the new NAS base URL. */
export function inferNasBaseUrl(value: string): string {
  const parsed = parsePrivateBaseUrl(value);
  let path = parsed.pathname.replace(/\/+$/, "");
  for (const suffix of LEGACY_SERVICE_SUFFIXES) {
    if (path === suffix) {
      path = "";
      break;
    }
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }
  parsed.pathname = path || "/";
  return formatBaseUrl(parsed);
}

export function migrateNasBaseUrl(current: string, legacy: Record<string, unknown> = {}): string {
  const candidate = typeof current === "string" && current.trim()
    ? current
    : [legacy.apiBaseUrl, legacy.syncApiBaseUrl, legacy.enrollmentPortalUrl]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim())) || "";
  if (!candidate) return "";
  try {
    return inferNasBaseUrl(candidate);
  } catch {
    // Preserve invalid input so the readiness view can report it without
    // losing the user's configuration during migration.
    return candidate.trim();
  }
}
