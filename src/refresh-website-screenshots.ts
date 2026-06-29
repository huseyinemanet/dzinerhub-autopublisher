import { config } from "./config.js";
import { connectFramer, getWebsitesCollection } from "./framer.js";
import { captureWebsite, withBrowser } from "./screenshot.js";

function entryValue(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const value = (entry as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

function imageField(value: string, alt: string) {
  return { type: "image" as const, value, alt };
}

function fieldId(fields: Map<string, { id: string }>, name: string): string {
  const field = fields.get(name.toLowerCase());
  if (!field) throw new Error(`Missing Framer field: ${name}`);
  return field.id;
}

function normalizeScreenshotUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    url.hash = "";
    url.searchParams.delete("ref");
    return url.toString();
  } catch {
    return "";
  }
}

function targetSlugs(): Set<string> {
  return new Set(
    (process.env.REFRESH_WEBSITE_SCREENSHOT_SLUGS ?? process.env.REFRESH_DRAFT_SCREENSHOT_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
  );
}

async function main(): Promise<void> {
  const onlySlugs = targetSlugs();
  if (onlySlugs.size === 0) {
    throw new Error("REFRESH_WEBSITE_SCREENSHOT_SLUGS is required");
  }

  const refreshFields =
    process.env.REFRESH_SCREENSHOT_FIELDS === "thumbnail" || process.env.REFRESH_SCREENSHOT_FIELDS === "full-image"
      ? process.env.REFRESH_SCREENSHOT_FIELDS
      : "all";

  const framer = await connectFramer();
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const { collection, fields } = await getWebsitesCollection(framer);
    const items = await collection.getItems();
    const titleFieldId = fieldId(fields, "Title");
    const externalLinkFieldId = fieldId(fields, "External Link");
    const thumbnailFieldId = fieldId(fields, "Thumbnail");
    const fullImageFieldId = fieldId(fields, "Full Image");

    const bySlug = new Map(items.map((item) => [item.slug, item]));

    await withBrowser(async (browser) => {
      for (const slug of onlySlugs) {
        const item = bySlug.get(slug);
        if (!item) {
          failed += 1;
          console.error(`Missing website item: ${slug}`);
          continue;
        }

        const title = entryValue(item.fieldData[titleFieldId]) || item.slug;
        const screenshotUrl = normalizeScreenshotUrl(entryValue(item.fieldData[externalLinkFieldId]));
        if (!screenshotUrl) {
          skipped += 1;
          console.log(`Skipped ${title}: missing external link`);
          continue;
        }

        try {
          console.log(`Refreshing ${title}: ${screenshotUrl}`);
          const metadata = await captureWebsite(browser, screenshotUrl);
          const fieldData: Record<string, ReturnType<typeof imageField>> = {};

          if (refreshFields === "all" || refreshFields === "thumbnail") {
            const thumbnail = await framer.uploadImage({
              image: {
                bytes: new Uint8Array(metadata.screenshot.thumbnail),
                mimeType: metadata.screenshot.mimeType,
              },
              name: `${item.slug}-thumbnail-refresh.jpg`,
              altText: `${title} website thumbnail`,
            });
            fieldData[thumbnailFieldId] = imageField(thumbnail.url, `${title} thumbnail`);
          }

          if (refreshFields === "all" || refreshFields === "full-image") {
            const fullImage = await framer.uploadImage({
              image: {
                bytes: new Uint8Array(metadata.screenshot.fullPage),
                mimeType: metadata.screenshot.mimeType,
              },
              name: `${item.slug}-full-refresh.jpg`,
              altText: `${title} full page website screenshot`,
            });
            fieldData[fullImageFieldId] = imageField(fullImage.url, `${title} full screenshot`);
          }

          await item.setAttributes({
            draft: item.draft,
            fieldData,
          });
          updated += 1;
          console.log(`Updated ${title}`);
        } catch (error) {
          failed += 1;
          console.error(`Failed ${title}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  } finally {
    await framer.disconnect();
  }

  console.log("Refresh summary");
  console.log(JSON.stringify({ updated, skipped, failed }, null, 2));

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
