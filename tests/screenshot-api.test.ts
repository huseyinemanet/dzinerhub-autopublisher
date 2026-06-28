import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  buildScreenshotApiUrl,
  fullImageWidth,
  normalizeFullImage,
  normalizeThumbnail,
  thumbnailSize,
} from "../src/screenshot-api.js";

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
  assert.equal(requestUrl.searchParams.get("blockPopups"), "true");
  assert.equal(requestUrl.searchParams.get("blockCookieBanners"), "true");
  assert.equal(requestUrl.searchParams.get("doScroll"), "true");
  assert.equal(requestUrl.searchParams.get("waitUntil"), "networkidle2");
  assert.equal(requestUrl.searchParams.get("delay"), "2500");
  assert.equal(requestUrl.searchParams.get("timeout"), "60000");
  assert.equal(requestUrl.searchParams.get("deviceScaleFactor"), "1");
  assert.equal(requestUrl.searchParams.get("scale"), "css");
  assert.match(requestUrl.searchParams.get("style") ?? "", /cookie/i);
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

test("normalizes full images to 1500px width", async () => {
  const input = await sharp({
    create: {
      width: 1440,
      height: 3200,
      channels: 3,
      background: "#eeeeee",
    },
  })
    .jpeg()
    .toBuffer();

  const output = await normalizeFullImage(input);
  const metadata = await sharp(output).metadata();

  assert.equal(metadata.width, fullImageWidth);
  assert.equal(metadata.height, 3333);
  assert.equal(metadata.format, "jpeg");
});
