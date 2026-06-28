import sharp from "sharp";
import { normalizedHost, parseHttpUrl } from "./url-identity.js";
import type { WebsiteMetadata } from "./types.js";

const blockedHosts = new Set([
  "behance.net",
  "cloudflare.com",
  "discord.com",
  "discord.gg",
  "dribbble.com",
  "facebook.com",
  "framer.com",
  "github.com",
  "google.com",
  "instagram.com",
  "linkedin.com",
  "medium.com",
  "pinterest.com",
  "producthunt.com",
  "shopify.com",
  "substack.com",
  "t.me",
  "twitter.com",
  "webflow.com",
  "x.com",
  "youtube.com",
  "youtu.be",
]);

const blockedAssetHosts = [
  "amazonaws.com",
  "cloudfront.net",
  "cloudinary.com",
  "framerusercontent.com",
  "imgix.net",
];

const assetSubdomainPrefixes = new Set([
  "asset",
  "assets",
  "cdn",
  "image",
  "images",
  "img",
  "media",
  "static",
  "thumb",
  "thumbnail",
]);

const utilityPaths = [
  "/api",
  "/assets",
  "/blog",
  "/careers",
  "/cdn-cgi",
  "/contact",
  "/cookie",
  "/cookies",
  "/docs",
  "/documentation",
  "/jobs",
  "/log-in",
  "/login",
  "/press",
  "/privacy",
  "/privacypolicy",
  "/sign-in",
  "/sign-up",
  "/signin",
  "/signup",
  "/static",
  "/support",
  "/terms",
  "/terms-of-service",
];

export function isLikelyAssetUrl(rawUrl: string): boolean {
  const url = parseHttpUrl(rawUrl);
  if (!url) return true;

  return /\.(avif|css|gif|ico|jpe?g|js|json|mov|mp3|mp4|pdf|png|svg|webm|webp|xml|zip)(\?|$)/i.test(url.pathname);
}

function isBlockedHost(host: string): boolean {
  if (blockedHosts.has(host)) return true;
  if ([...blockedHosts].some((blocked) => host.endsWith(`.${blocked}`))) return true;
  if (blockedAssetHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return true;

  const firstLabel = host.split(".")[0] ?? "";
  return host.split(".").length > 2 && assetSubdomainPrefixes.has(firstLabel);
}

function isCuratorHost(host: string, curatorHosts: Set<string>): boolean {
  return [...curatorHosts].some((curatorHost) => host === curatorHost || host.endsWith(`.${curatorHost}`));
}

function isUtilityUrl(rawUrl: string): boolean {
  const url = parseHttpUrl(rawUrl);
  if (!url) return true;

  const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const query = url.search.toLowerCase();
  if (query.includes("challenge")) return true;

  return utilityPaths.some((needle) => path === needle || path.startsWith(`${needle}/`));
}

export function candidateRejectReason(rawUrl: string, curatorHosts = new Set<string>()): string | null {
  const url = parseHttpUrl(rawUrl);
  if (!url) return "invalid url";

  const host = normalizedHost(rawUrl);
  if (isCuratorHost(host, curatorHosts)) return "curator host";
  if (isBlockedHost(host)) return "blocked host";
  if (isLikelyAssetUrl(rawUrl)) return "asset url";
  if (isUtilityUrl(rawUrl)) return "utility url";

  return null;
}

function isGenericTitle(value: string): boolean {
  return /^(home|index|untitled|welcome|website|landing page)$/i.test(value.trim());
}

export function capturedPageErrorReason(metadata: Pick<WebsiteMetadata, "browserErrors" | "statusCode" | "title" | "visualContext">): string | null {
  if (metadata.statusCode && metadata.statusCode >= 400) return `http ${metadata.statusCode}`;

  const visibleText = [
    metadata.title,
    ...metadata.visualContext.headings,
    ...metadata.visualContext.visibleText,
    ...metadata.browserErrors,
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const fatalPatterns: Array<[RegExp, string]> = [
    [/application error: a client-side exception has occurred/i, "client-side application error"],
    [/client-side exception has occurred/i, "client-side application error"],
    [/see the browser console for more information/i, "browser console application error"],
    [/hydration failed|minified react error|react error boundary/i, "react runtime error"],
    [/chunkloaderror|loading chunk \d+ failed|failed to fetch dynamically imported module/i, "asset loading error"],
    [/internal server error|bad gateway|service unavailable|gateway timeout/i, "server error page"],
    [/this site can.t be reached|err_name_not_resolved|err_connection|err_timed_out/i, "browser error page"],
  ];

  for (const [pattern, reason] of fatalPatterns) {
    if (pattern.test(visibleText)) return reason;
  }

  return null;
}

async function isBlankScreenshot(image: Buffer): Promise<boolean> {
  const resized = await sharp(image)
    .resize(48, 48, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = resized.data.length / 3;
  if (!pixels) return true;

  let luminanceTotal = 0;
  const luminances: number[] = [];
  const buckets = new Set<string>();

  for (let index = 0; index < resized.data.length; index += 3) {
    const r = resized.data[index] ?? 0;
    const g = resized.data[index + 1] ?? 0;
    const b = resized.data[index + 2] ?? 0;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    luminanceTotal += luminance;
    luminances.push(luminance);
    buckets.add(`${Math.round(r / 32)},${Math.round(g / 32)},${Math.round(b / 32)}`);
  }

  const average = luminanceTotal / pixels;
  const variance = luminances.reduce((sum, value) => sum + (value - average) ** 2, 0) / pixels;
  return Math.sqrt(variance) < 2 && buckets.size <= 2;
}

export async function validateCapturedWebsite(metadata: WebsiteMetadata): Promise<string | null> {
  const finalUrlReason = candidateRejectReason(metadata.finalUrl);
  if (finalUrlReason) return `final url ${finalUrlReason}`;

  if (metadata.contentType && !/text\/html|application\/xhtml\+xml/i.test(metadata.contentType)) {
    return `non-html response (${metadata.contentType})`;
  }

  const errorReason = capturedPageErrorReason(metadata);
  if (errorReason) return errorReason;

  const visibleTextCount = new Set([...metadata.visualContext.headings, ...metadata.visualContext.visibleText]).size;
  if (isGenericTitle(metadata.title) && visibleTextCount < 2) return "weak page title and text";
  if (visibleTextCount < 1 && metadata.visualContext.imageCount < 1) return "no visible content";
  if (await isBlankScreenshot(metadata.screenshot.thumbnail)) return "blank screenshot";

  return null;
}
