export type Change = "unchanged" | "created" | "modified" | "deleted";
export type Resolution = "download" | "upload" | "conflict" | "none";

/** Pure three-way decision model. It never reads or writes vault files. */
export function resolveChange(local: Change, remote: Change): Resolution {
  if (local === "unchanged" && remote === "unchanged") return "none";
  if (local === "unchanged") return "download";
  if (remote === "unchanged") return "upload";
  return "conflict";
}

export function conflictPath(path: string, device: string, timestamp: string): string {
  const name = device.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "device";
  const time = timestamp.replace(/[^0-9TZ-]/g, "");
  const dot = path.lastIndexOf(".");
  return dot > 0 ? `${path.slice(0, dot)}.conflict-${name}-${time}${path.slice(dot)}` : `${path}.conflict-${name}-${time}`;
}

/** Returns the original path only for filenames created by conflictPath. */
export function sourcePathForConflictCopy(path: string): string | undefined {
  const match = /^(.*)\.conflict-[a-z0-9-]+-\d{4}-\d{2}-\d{2}T\d{6,}Z(\.[^/]+)?$/i.exec(path);
  return match ? `${match[1]}${match[2] || ""}` : undefined;
}
