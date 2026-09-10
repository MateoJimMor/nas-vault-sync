export interface Response { status: number; text: string; arrayBuffer?: ArrayBuffer }
export interface Request { url: string; method: string; headers: Record<string, string>; body?: string | ArrayBuffer; throw: false }
export type Transport = (request: Request) => Promise<Response>;

export async function requestApi(transport: Transport, base: string, token: string, path: string, method = "GET", body?: unknown): Promise<any> {
  let url: URL;
  try { url = new URL(base.trim()); } catch { throw new Error("Configure a valid NAS API URL in plugin settings."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS API URL without credentials, query, or fragment.");
  }
  if (!path.startsWith("/v1/") || path.includes("..")) throw new Error("Invalid API path.");
  if (!token) throw new Error("Connect this device to NAS first.");
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await transport({ url: base.trim().replace(/\/$/, "") + path, method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), throw: false });
  } catch { throw new Error("Cannot reach the NAS API. Check the private connection and server address."); }
  // Never display raw backend or transport errors: they may contain credentials or user content.
  if (response.status === 401 || response.status === 403) throw new Error("NAS access denied. Check this device's authorization.");
  if (response.status === 409 || response.status === 412) throw new Error("The server copy changed. Refresh before editing again.");
  if (response.status < 200 || response.status >= 300) throw new Error(`NAS request failed (HTTP ${response.status}).`);
  let data: any;
  try { data = JSON.parse(response.text); } catch { throw new Error("NAS returned an invalid JSON response."); }
  if (!data || data.apiVersion !== 1) throw new Error("NAS API version is incompatible with this plugin.");
  return data;
}
