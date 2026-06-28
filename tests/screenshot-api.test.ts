import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { buildScreenshotApiUrl, normalizeThumbnail, thumbnailSize } from "../src/screenshot-api.js";

test("builds ScreenshotAPI request URL with DzinerHub defaults", () => {
  const requestUrl = new URL(
    buildScreenshotApiUrl({
      apiKey: "test-key",
      url: "https://example.com/",
      fullPage: true,
      viewportWidth: 1440,
      viewportHeight: 1600,
      quality: 82,
    }),
  );

  assert.equal(requestUrl.origin, "https://api.screenshotapi.com");
  assert.equal(requestUrl.pathname, "/take");
  assert.equal(requestUrl.searchParams.get("apiKey"), "test-key");
  assert.equal(requestUrl.searchParams.get("url"), "https://example.com/");
  assert.equal(requestUrl.searchParams.get("responseType"), "redirect");
  assert.equal(requestUrl.searchParams.get("type"), "jpeg");
  assert.equal(requestUrl.searchParams.get("quality"), "82");
  assert.equal(requestUrl.searchParams.get("viewportWidth"), "1440");
  assert.equal(requestUrl.searchParams.get("viewportHeight"), "1600");
  assert.equal(requestUrl.searchParams.get("fullPage"), "true");
  assert.equal(requestUrl.searchParams.get("blockCookieBanners"), "true");
  assert.equal(requestUrl.searchParams.get("doScroll"), "true");
});

test("normalizes thumbnails to 640x960", async () => {
  const input = await sharp({
    create: {
      width: 1280,
      height: 1920,
      channels: 3,
      background: "#111111",
    },
  })
    .jpeg()
    .toBuffer();

  const output = await normalizeThumbnail(input);
  const metadata = await sharp(output).metadata();

  assert.equal(metadata.width, thumbnailSize.width);
  assert.equal(metadata.height, thumbnailSize.height);
  assert.equal(metadata.format, "jpeg");
});
