export interface ConnectionReadiness {
  api: "ready" | "missing" | "invalid";
  token: "present" | "missing";
}

/**
 * Produces a redacted, local readiness assessment. It never returns the URL
 * or token and does not make a network request.
 */
export function connectionReadiness(apiBaseUrl: string, token: string): ConnectionReadiness {
  let api: ConnectionReadiness["api"] = "ready";
  try {
    const url = new URL(apiBaseUrl.trim());
    if (!apiBaseUrl.trim() || !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash) api = "invalid";
  } catch {
    api = apiBaseUrl.trim() ? "invalid" : "missing";
  }
  return { api, token: token.trim() ? "present" : "missing" };
}
