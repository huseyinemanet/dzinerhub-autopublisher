import { config } from "./config.js";
import { screenshotRejectReason } from "./candidate-validation.js";
import { connectFramer, getWebsitesCollection } from "./framer.js";
import {
  captureFullImageWithScreenshotApi,
  captureThumbnailWithScreenshotApi,
  captureWithScreenshotApi,
} from "./screenshot-api.js";

function optionalNumberEnv(name: string): number | null {
  const value = process.env[name];
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

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

async function main(): Promise<void> {
  if (!config.screenshotApiKey) {
    throw new Error("SCREENSHOTAPI_API_KEY is required");
  }

  const limit = optionalNumberEnv("REFRESH_DRAFT_SCREENSHOT_LIMIT");
  const onlySlugs = new Set(
    (process.env.REFRESH_DRAFT_SCREENSHOT_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
  );
  const refreshFields =
    process.env.REFRESH_SCREENSHOT_FIELDS === "all" || process.env.REFRESH_SCREENSHOT_FIELDS === "full-image"
      ? process.env.REFRESH_SCREENSHOT_FIELDS
      : "thumbnail";
  const refreshScope =
    process.env.REFRESH_SCREENSHOT_SCOPE === "all" || process.env.REFRESH_SCREENSHOT_SCOPE === "live"
      ? process.env.REFRESH_SCREENSHOT_SCOPE
      : "draft";

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

    const targetItems = items.filter((item) =>
      refreshScope === "all" ? true : refreshScope === "live" ? !item.draft : item.draft,
    );
    console.log(`Found ${targetItems.length} ${refreshScope} website item(s).`);
    console.log(
      `Refreshing ${
        refreshFields === "all" ? "thumbnail and full image" : refreshFields === "full-image" ? "full image only" : "thumbnail only"
      }.`,
    );

    for (const item of targetItems) {
      if (limit && updated >= limit) break;
      if (onlySlugs.size > 0 && !onlySlugs.has(item.slug)) {
        skipped += 1;
        continue;
      }

      const title = entryValue(item.fieldData[titleFieldId]) || item.slug;
      const externalLink = entryValue(item.fieldData[externalLinkFieldId]);
      const screenshotUrl = normalizeScreenshotUrl(externalLink);

      if (!screenshotUrl) {
        skipped += 1;
        console.log(`Skipped ${title}: missing external link`);
        continue;
      }

      try {
        console.log(`Refreshing ${title}: ${screenshotUrl}`);
        const screenshot =
          refreshFields === "all"
            ? await captureWithScreenshotApi(config.screenshotApiKey, screenshotUrl)
            : refreshFields === "full-image"
              ? {
                  thumbnail: null,
                  fullPage: await captureFullImageWithScreenshotApi(config.screenshotApiKey, screenshotUrl),
                  mimeType: "image/jpeg" as const,
                }
            : {
                thumbnail: await captureThumbnailWithScreenshotApi(config.screenshotApiKey, screenshotUrl),
                fullPage: null,
                mimeType: "image/jpeg" as const,
              };

        const imageToValidate = screenshot.thumbnail ?? screenshot.fullPage;
        const invalidReason = imageToValidate ? await screenshotRejectReason(imageToValidate) : null;
        if (invalidReason) {
          skipped += 1;
          console.log(`Skipped ${title}: ${invalidReason}`);
          continue;
        }

        const fieldData: Record<string, ReturnType<typeof imageField>> = {};

        if (screenshot.thumbnail) {
          const thumbnail = await framer.uploadImage({
            image: {
              bytes: new Uint8Array(screenshot.thumbnail),
              mimeType: screenshot.mimeType,
            },
            name: `${item.slug}-thumbnail-screenshotapi.jpg`,
            altText: `${title} website thumbnail`,
          });
          fieldData[thumbnailFieldId] = imageField(thumbnail.url, `${title} thumbnail`);
        }

        if (screenshot.fullPage) {
          const fullImage = await framer.uploadImage({
            image: {
              bytes: new Uint8Array(screenshot.fullPage),
              mimeType: screenshot.mimeType,
            },
            name: `${item.slug}-full-screenshotapi.jpg`,
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
  } finally {
    await framer.disconnect();
  }

  console.log("Refresh summary");
  console.log(
    JSON.stringify(
      {
        updated,
        skipped,
        failed,
      },
      null,
      2,
    ),
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
