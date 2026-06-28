import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { z } from "zod";
import type { Browser, Page } from "playwright";
import { config } from "./config.js";
import {
  addInspirationItem,
  connectFramer,
  getExistingInspirationSlugs,
  getExistingInspirationUrlKeys,
  getInspirationCollection,
  publishIfRequested,
  uniqueStorySlug,
} from "./framer.js";
import { InspirationReportBuilder } from "./report.js";
import { domainFromUrl, normalizeUrl, slugify } from "./slug.js";
import { loadManualSources, loadSourceFile } from "./sources.js";
import type { InspirationCandidate, InspirationSyncSummary } from "./types.js";
import { canonicalUrlKey } from "./url-identity.js";
import { withBrowser } from "./screenshot.js";

const rawInspirationClassificationSchema = z.object({}).catchall(z.unknown());

const BLOCKED_HOSTS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "pinterest.com",
  "reddit.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
]);

const BLOCKED_PATH_PARTS = [
  "/about",
  "/advertise",
  "/archive",
  "/author",
  "/category",
  "/contact",
  "/course",
  "/courses",
  "/events",
  "/jobs",
  "/login",
  "/newsletter",
  "/privacy",
  "/rss",
  "/search",
  "/shop",
  "/signin",
  "/signup",
  "/subscribe",
  "/tag",
  "/terms",
];

const LISTING_SEGMENTS = new Set([
  "architecture",
  "art",
  "articles",
  "culture",
  "design",
  "fashion",
  "film",
  "inspiration",
  "news",
  "photo",
  "photography",
  "projects",
  "stories",
]);

const TAG_OVERRIDES = new Map<string, string>([
  ["ai", "AI"],
  ["ux", "UX"],
  ["ui", "UI"],
  ["3d", "3D"],
]);

interface InspirationImageCandidate {
  url: string;
  width: number;
  height: number;
  source: string;
}

interface InspirationMetadata {
  sourceUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  title: string;
  ogTitle: string;
  description: string;
  statusCode: number | null;
  headings: string[];
  articleText: string[];
  visibleText: string[];
  imageCandidates: InspirationImageCandidate[];
}

function host(rawUrl: string): string {
  return domainFromUrl(rawUrl);
}

function formatTag(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized || normalized === "unknown") return "Inspiration";

  return normalized
    .split(" ")
    .map((word) => TAG_OVERRIDES.get(word) ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(record[key]).trim();
    if (value) return value;
  }
  return "";
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "publish"].includes(normalized)) return true;
  if (["0", "false", "no", "skip"].includes(normalized)) return false;
  return null;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : fallback;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function softenCuratorTone(value: string): string {
  return value
    .replace(/\bmust-see\b/gi, "strong reference")
    .replace(/\bmust-read\b/gi, "useful reference")
    .replace(/\bstunning\b/gi, "notable")
    .replace(/\bbreathtaking\b/gi, "expansive")
    .replace(/\bfascinating\b/gi, "layered")
    .replace(/\bessential\b/gi, "useful")
    .replace(/\bmasterful(?:ly)?\b/gi, "considered")
    .replace(/\bbrilliant\b/gi, "vivid")
    .replace(/\s+/g, " ")
    .trim();
}

function paragraphList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringValue).map(softenCuratorTone).map((item) => truncate(item, 420)).filter(Boolean).slice(0, 3);
  }

  const text = stringValue(value);
  if (!text) return [];

  return text
    .split(/\n{2,}|(?<=\.)\s+(?=[A-Z])/)
    .map(softenCuratorTone)
    .map((item) => truncate(item, 420))
    .filter(Boolean)
    .slice(0, 3);
}

function parseJsonContent(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fenced?.[1] ?? content).trim();

  try {
    return JSON.parse(source);
  } catch {
    const objectMatch = source.match(/\{[\s\S]*\}/);
    if (!objectMatch) throw new Error("No JSON object found in model response");
    return JSON.parse(objectMatch[0]);
  }
}

export function isUsefulInspirationUrl(rawUrl: string, sourceUrl = "", options: { rejectSame?: boolean } = {}): boolean {
  if (/^(mailto|tel|javascript):/i.test(rawUrl)) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (/\.(avif|css|gif|ico|jpeg|jpg|js|json|mp4|pdf|png|svg|webm|webp|xml)$/i.test(url.pathname)) return false;
  if (options.rejectSame !== false && sourceUrl && canonicalUrlKey(url.toString()) === canonicalUrlKey(sourceUrl)) return false;

  const normalizedHost = host(url.toString());
  const sourceHost = sourceUrl ? host(sourceUrl) : "";
  if (!normalizedHost || BLOCKED_HOSTS.has(normalizedHost)) return false;
  if (sourceHost && normalizedHost !== sourceHost) return false;

  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  if (!path || path === "/" || path === "/en" || path === "/en.html") return false;
  if (BLOCKED_PATH_PARTS.some((part) => path.includes(part))) return false;

  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (segments.length === 1 && LISTING_SEGMENTS.has(segments[0] ?? "")) return false;
  if (segments[0] === "page" && segments.length === 2 && /^\d+$/.test(segments[1] ?? "")) return false;
  if (segments[0] === "blog" && segments.length === 2 && LISTING_SEGMENTS.has(segments[1] ?? "")) return false;
  if (segments.length === 2 && LISTING_SEGMENTS.has(segments[0] ?? "") && /^\d+$/.test(segments[1] ?? "")) return false;

  return true;
}

function uniquePush(list: string[], seen: Set<string>, value: string): void {
  const key = canonicalUrlKey(value);
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push(value);
}

async function goto(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function discoverInspirationUrls(browser: Browser, sourceUrls: string[], limit: number): Promise<string[]> {
  const buckets: string[][] = [];
  const globalSeen = new Set<string>();
  const sourceLimit = Math.max(6, Math.ceil(limit / Math.max(sourceUrls.length, 1)));

  for (const source of sourceUrls.slice(0, config.maxInspirationDiscoveryPages)) {
    const sourceUrl = normalizeUrl(source);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
    page.setDefaultTimeout(3500);
    const sourceCandidates: string[] = [];
    const sourceSeen = new Set<string>();

    try {
      console.log(`Discovering inspiration from ${sourceUrl}`);
      if (!(await goto(page, sourceUrl))) continue;

      const hrefs = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
          .map((anchor) => anchor.href)
          .filter(Boolean),
      );

      for (const href of hrefs) {
        if (sourceCandidates.length >= sourceLimit) break;
        try {
          if (/^(mailto|tel|javascript):/i.test(href)) continue;
          const normalized = normalizeUrl(new URL(href, sourceUrl).toString());
          if (!isUsefulInspirationUrl(normalized, sourceUrl)) continue;
          if (globalSeen.has(canonicalUrlKey(normalized))) continue;
          uniquePush(sourceCandidates, sourceSeen, normalized);
          globalSeen.add(canonicalUrlKey(normalized));
        } catch {
          continue;
        }
      }
    } finally {
      await page.close();
    }

    if (sourceCandidates.length > 0) buckets.push(sourceCandidates);
  }

  const discovered: string[] = [];
  for (let index = 0; discovered.length < limit; index += 1) {
    let addedInRound = false;
    for (const bucket of buckets) {
      const url = bucket[index];
      if (!url) continue;
      discovered.push(url);
      addedInRound = true;
      if (discovered.length >= limit) break;
    }
    if (!addedInRound) break;
  }

  return discovered;
}

async function readInspirationMetadata(browser: Browser, url: string): Promise<InspirationMetadata> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(3500);

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 9000 }).catch(() => undefined);
    await page.waitForTimeout(900);

    const finalUrl = page.url();
    const title = (await page.title().catch(() => "")).trim();
    const ogTitle = ((await page.locator('meta[property="og:title"]').first().getAttribute("content").catch(() => "")) || "").trim();
    const description =
      (await page.locator('meta[name="description"]').first().getAttribute("content").catch(() => "")) ||
      (await page.locator('meta[property="og:description"]').first().getAttribute("content").catch(() => "")) ||
      "";
    const canonicalUrl =
      (await page.locator('link[rel="canonical"]').first().getAttribute("href").catch(() => "")) || finalUrl;
    const headings = await page
      .evaluate(() =>
        [...document.querySelectorAll("h1, h2")]
          .map((heading) => heading.textContent?.trim() ?? "")
          .filter((text) => text.length >= 4)
          .slice(0, 10),
      )
      .catch(() => []);
    const articleText = await page
      .evaluate(() =>
        [...document.querySelectorAll("article p, main p, [role='main'] p")]
          .map((paragraph) => paragraph.textContent?.trim() ?? "")
          .filter((text) => text.length >= 70)
          .slice(0, 12),
      )
      .catch(() => []);
    const visibleText = await page
      .evaluate(() =>
        (document.body?.innerText ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length >= 12)
          .slice(0, 28),
      )
      .catch(() => []);
    const imageCandidates = await page
      .evaluate(() => {
        const imageUrls = [
          ...[...document.querySelectorAll<HTMLMetaElement>('meta[property="og:image"], meta[name="twitter:image"]')]
            .map((meta) => meta.content)
            .filter(Boolean)
            .map((url) => ({ url, width: 0, height: 0, source: "meta" })),
          ...[...document.querySelectorAll<HTMLImageElement>("article img, main img, [role='main'] img, img")]
            .map((image) => {
              const rect = image.getBoundingClientRect();
              return {
                url: image.currentSrc || image.src,
                width: image.naturalWidth || Math.round(rect.width),
                height: image.naturalHeight || Math.round(rect.height),
                source: "image",
              };
            })
            .filter((image) => image.url),
        ];
        return imageUrls.slice(0, 24);
      })
      .catch(() => []);

    return {
      sourceUrl: url,
      finalUrl,
      canonicalUrl: new URL(canonicalUrl, finalUrl).toString(),
      title,
      ogTitle,
      description: description.trim(),
      statusCode: response?.status() ?? null,
      headings,
      articleText,
      visibleText,
      imageCandidates: imageCandidates
        .map((image) => {
          try {
            return {
              ...image,
              url: new URL(image.url, finalUrl).toString(),
            };
          } catch {
            return null;
          }
        })
        .filter((image): image is InspirationImageCandidate => Boolean(image)),
    };
  } finally {
    await page.close();
  }
}

function invalidMetadataReason(metadata: InspirationMetadata): string {
  if (metadata.statusCode && metadata.statusCode >= 400) return `http ${metadata.statusCode}`;
  if (!metadata.title && !metadata.ogTitle) return "missing title";

  const text = [
    metadata.title,
    metadata.ogTitle,
    metadata.description,
    ...metadata.headings.slice(0, 4),
    ...metadata.visibleText.slice(0, 6),
  ].join(" ").toLowerCase();

  if (/access denied|captcha|enable javascript|just a moment|not found|page unavailable|verify you are human/.test(text)) {
    return "blocked or error page";
  }

  if (metadata.imageCandidates.length === 0) return "missing image candidates";

  return "";
}

async function downloadImage(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "image/avif,image/webp,image/jpeg,image/png,*/*",
        "user-agent": "Mozilla/5.0 DzinerHubAutopublisher/1.0",
      },
    });
    if (!response.ok) throw new Error(`image http ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function preparePhoto(candidates: InspirationImageCandidate[]): Promise<InspirationCandidate["photo"]> {
  const ranked = [...candidates].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  const errors: string[] = [];

  for (const candidate of ranked.slice(0, 8)) {
    try {
      const input = await downloadImage(candidate.url);
      const source = sharp(input, { animated: false }).rotate();
      const metadata = await source.metadata();
      const width = metadata.width ?? candidate.width;
      const height = metadata.height ?? candidate.height;
      const aspect = width / Math.max(height, 1);

      if (width < 700 || height < 420) throw new Error(`image too small ${width}x${height}`);
      if (aspect < 0.55 || aspect > 2.8) throw new Error(`image aspect rejected ${aspect.toFixed(2)}`);

      const bytes = await source
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer();
      const normalized = await sharp(bytes).metadata();

      return {
        bytes,
        mimeType: "image/jpeg",
        sourceUrl: candidate.url,
        width: normalized.width ?? width,
        height: normalized.height ?? height,
      };
    } catch (error) {
      errors.push(`${candidate.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`no usable image (${errors.slice(0, 3).join("; ")})`);
}

export function normalizeInspirationClassification(
  value: unknown,
  metadata: InspirationMetadata,
): Omit<InspirationCandidate, "sourceUrl" | "finalUrl" | "slug" | "photo" | "contributorSlugs"> & { shouldPublish: boolean } {
  const record = rawInspirationClassificationSchema.parse(value);
  const title = truncate(firstString(record, ["title", "name"]) || metadata.ogTitle || metadata.title, 150);
  const tag = formatTag(firstString(record, ["tag", "category"]) || "Inspiration");
  const aiComment = truncate(softenCuratorTone(firstString(record, ["aiComment", "comment", "summary"]) || metadata.description), 180);
  const aiContent = paragraphList(record.aiContent ?? record.content ?? record.note);
  const qualityScore = numberValue(record.qualityScore ?? record.score, 0);
  const shouldPublish = booleanValue(record.shouldPublish ?? record.publish) ?? Boolean(title && qualityScore >= config.minInspirationQualityScore);

  return {
    title,
    tag,
    aiComment,
    aiContent: aiContent.length
      ? aiContent
      : [
          `${title} stands out as a visual reference because it gives a clear creative idea enough room to breathe.`,
          "The work feels worth saving for its image-making, material choices, or point of view rather than for news value alone.",
        ],
    qualityScore,
    shouldPublish,
  };
}

async function classifyInspiration(
  metadata: InspirationMetadata,
): Promise<Omit<InspirationCandidate, "sourceUrl" | "finalUrl" | "slug" | "photo" | "contributorSlugs"> & { shouldPublish: boolean }> {
  if (!config.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is required for inspiration classification");
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      temperature: 0.32,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You curate a selective visual inspiration feed for DzinerHub. Return strict JSON only. Publish only visually strong art, design, photography, illustration, architecture, craft, fashion, film, or creative culture projects with strong imagery. Skip generic news, weak listicles, press releases, product announcements, politics, market news, event pages, shop pages, and articles without a clear visual reference. Write original curator notes; do not copy the article. Avoid hype phrases like must-see, stunning, breathtaking, fascinating, or essential.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Decide whether this page deserves a place in a selective visual Inspiration CMS.",
            requiredShape: {
              title: "clean title, max 150 characters",
              tag: "one of: Art, Design, Illustration, Photography, Architecture, Branding, Fashion, Film, Installation, Craft, Creative Tech, Culture",
              aiComment: "one short curator sentence, max 160 characters",
              aiContent: ["2 short paragraphs, 45-75 words each, original DzinerHub curator note"],
              qualityScore: "number from 0 to 1; use 0.82+ only for visually strong items",
              shouldPublish: "boolean; true only if this is strong visual inspiration",
            },
            page: {
              url: metadata.canonicalUrl || metadata.finalUrl,
              title: metadata.title,
              ogTitle: metadata.ogTitle,
              description: metadata.description,
              headings: metadata.headings,
              articleText: metadata.articleText,
              visibleText: metadata.visibleText.slice(0, 14),
              imageCandidates: metadata.imageCandidates.slice(0, 6),
            },
          }),
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`DeepSeek inspiration request failed with ${response.status}`);

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned an empty inspiration response");

  const source = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content;
  const parsed = JSON.parse(source.trim().match(/\{[\s\S]*\}/)?.[0] ?? source.trim());
  return normalizeInspirationClassification(parsed, metadata);
}

async function main(): Promise<void> {
  const report = new InspirationReportBuilder();
  const summary: InspirationSyncSummary = {
    discovered: 0,
    scanned: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    skippedLowQuality: 0,
    failed: 0,
    created: 0,
    dryRun: config.dryRun,
    published: false,
  };

  const sourceFile = await loadSourceFile(config.inspirationSourceFile);
  const manualUrls = await loadManualSources(config.inspirationSourceFile, config.maxInspiration);
  const discoveredUrls = await withBrowser((browser) =>
    discoverInspirationUrls(browser, sourceFile.discoveryPages, config.maxInspiration * 10),
  );
  const urls = [...discoveredUrls, ...manualUrls];
  const runUrlKeys = new Set<string>();

  summary.discovered = discoveredUrls.length;
  console.log(`Prepared ${urls.length} inspiration candidate URL(s).`);

  const initialFramer = await connectFramer();
  const { existingUrlKeys, existingSlugs } = await (async () => {
    try {
      const { collection, fields } = await getInspirationCollection(initialFramer);
      return {
        existingUrlKeys: await getExistingInspirationUrlKeys(collection, fields),
        existingSlugs: await getExistingInspirationSlugs(collection),
      };
    } finally {
      await initialFramer.disconnect();
    }
  })();

  await withBrowser(async (browser) => {
    for (const rawUrl of urls) {
      if (summary.created >= config.maxInspiration) {
        console.log(`Reached MAX_INSPIRATION=${config.maxInspiration}; stopping.`);
        break;
      }

      let url = "";
      try {
        url = normalizeUrl(rawUrl);
      } catch {
        summary.skippedInvalid += 1;
        report.addSkipped(rawUrl, "invalid URL");
        continue;
      }

      const key = canonicalUrlKey(url);
      if (!key || runUrlKeys.has(key)) continue;
      runUrlKeys.add(key);

      summary.scanned += 1;
      console.log(`Scanning inspiration ${url}`);

      try {
        if (existingUrlKeys.has(key)) {
          summary.skippedDuplicate += 1;
          report.addSkipped(url, "duplicate source URL");
          console.log(`Skipped duplicate inspiration: ${url}`);
          continue;
        }

        const metadata = await readInspirationMetadata(browser, url);
        if (!isUsefulInspirationUrl(metadata.canonicalUrl || metadata.finalUrl, "", { rejectSame: false })) {
          summary.skippedInvalid += 1;
          report.addSkipped(url, "invalid final URL");
          console.log(`Skipped invalid inspiration final URL: ${metadata.finalUrl}`);
          continue;
        }

        const finalKey = canonicalUrlKey(metadata.canonicalUrl || metadata.finalUrl);
        if (finalKey && runUrlKeys.has(finalKey) && finalKey !== key) {
          summary.skippedDuplicate += 1;
          report.addSkipped(url, "duplicate final URL in this run");
          continue;
        }
        if (finalKey && existingUrlKeys.has(finalKey)) {
          summary.skippedDuplicate += 1;
          report.addSkipped(url, "duplicate final URL");
          console.log(`Skipped duplicate inspiration final URL: ${metadata.finalUrl}`);
          continue;
        }
        if (finalKey) runUrlKeys.add(finalKey);

        const invalidReason = invalidMetadataReason(metadata);
        if (invalidReason) {
          summary.skippedInvalid += 1;
          report.addSkipped(url, invalidReason);
          console.log(`Skipped invalid inspiration: ${url} (${invalidReason})`);
          continue;
        }

        const photo = await preparePhoto(metadata.imageCandidates);
        const classified = await classifyInspiration(metadata);
        if (!classified.title || !classified.shouldPublish || classified.qualityScore < config.minInspirationQualityScore) {
          summary.skippedLowQuality += 1;
          const reason = classified.shouldPublish ? `low quality: ${classified.qualityScore}` : "not strong visual inspiration";
          report.addSkipped(url, reason);
          console.log(`Skipped inspiration: ${url} (${reason})`);
          continue;
        }

        const candidate: InspirationCandidate = {
          ...classified,
          sourceUrl: url,
          finalUrl: metadata.canonicalUrl || metadata.finalUrl,
          photo,
          contributorSlugs: ["huseyinemanet"],
          slug: uniqueStorySlug(existingSlugs, slugify(classified.title) || slugify(host(metadata.finalUrl))),
        };

        if (config.dryRun) {
          console.log(JSON.stringify({ ...candidate, photo: { ...candidate.photo, bytes: `${candidate.photo.bytes.length} bytes` } }, null, 2));
        } else {
          const writerFramer = await connectFramer();
          try {
            const { collection, fields } = await getInspirationCollection(writerFramer);
            const latestUrlKeys = await getExistingInspirationUrlKeys(collection, fields);
            const latestKey = canonicalUrlKey(candidate.finalUrl);
            if (latestKey && latestUrlKeys.has(latestKey)) {
              summary.skippedDuplicate += 1;
              report.addSkipped(url, "duplicate before write");
              continue;
            }
            await addInspirationItem(writerFramer, collection, fields, candidate);
          } finally {
            await writerFramer.disconnect();
          }
        }

        const candidateKey = canonicalUrlKey(candidate.finalUrl);
        if (candidateKey) existingUrlKeys.add(candidateKey);
        summary.created += 1;
        report.addCreated(candidate);
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        report.addFailed(url, message);
        console.error(`Failed inspiration ${url}: ${message}`);
      }
    }
  });

  if (summary.created > 0) {
    const publishFramer = await connectFramer();
    try {
      summary.published = await publishIfRequested(publishFramer, true);
    } finally {
      await publishFramer.disconnect();
    }
  }

  await report.write(summary);

  console.log("Inspiration summary");
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
