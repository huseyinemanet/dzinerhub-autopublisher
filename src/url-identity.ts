const TRACKING_PARAM_EXACT = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "ref",
]);

const TRACKING_PARAM_PREFIXES = [
  "utm_",
  "mc_",
  "_hs",
];

function isTrackingParam(name: string): boolean {
  const normalized = name.toLowerCase();
  return TRACKING_PARAM_EXACT.has(normalized) || TRACKING_PARAM_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function parseHttpUrl(rawUrl: string): URL | null {
  const value = rawUrl.trim();
  if (!value) return null;

  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

export function normalizedHost(rawUrl: string): string {
  const url = parseHttpUrl(rawUrl);
  return url ? url.hostname.toLowerCase().replace(/^www\./, "") : "";
}

export function canonicalUrlKey(rawUrl: string): string {
  const url = parseHttpUrl(rawUrl);
  if (!url) return "";

  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  url.username = "";
  url.password = "";
  url.port = "";

  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  let path = decodeURIComponent(url.pathname || "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
  if (!path) path = "/";

  const query = url.searchParams.toString();
  return `https://${url.hostname}${path === "/" ? "" : path}${query ? `?${query}` : ""}`;
}

export function urlIdentityKeys(...rawUrls: Array<string | undefined>): Set<string> {
  const keys = new Set<string>();

  for (const rawUrl of rawUrls) {
    if (!rawUrl) continue;
    const key = canonicalUrlKey(rawUrl);
    if (key) keys.add(key);
  }

  return keys;
}
