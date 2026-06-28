import { canonicalUrlKey, normalizedHost } from "./url-identity.js";

export function normalizeUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  const url = new URL(value.startsWith("http") ? value : `https://${value}`);
  url.hash = "";
  return url.toString();
}

export function domainFromUrl(rawUrl: string): string {
  return normalizedHost(rawUrl);
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isGenericTitle(value: string): boolean {
  return /^(home|index|untitled|welcome|website|landing-page|landing page)$/i.test(value.trim());
}

function slugFromUrl(rawUrl: string): string {
  const key = canonicalUrlKey(rawUrl) || normalizeUrl(rawUrl);
  const url = new URL(key);
  const hostParts = url.hostname.replace(/^www\./, "").split(".");
  const domain = hostParts.length > 1 ? hostParts.slice(0, -1).join("-") : hostParts[0];
  const path = url.pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 3)
    .join("-");

  return slugify([domain, path].filter(Boolean).join("-"));
}

export function slugForWebsite(title: string, url: string): string {
  const fromTitle = isGenericTitle(title) ? "" : slugify(title);
  if (fromTitle) return fromTitle;
  return slugFromUrl(url);
}

export function appendRefParam(rawUrl: string, ref: string): string {
  const url = new URL(normalizeUrl(rawUrl));
  if (!url.searchParams.has("ref")) {
    url.searchParams.set("ref", ref);
  }
  return url.toString();
}
