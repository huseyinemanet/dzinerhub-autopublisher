import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { candidateRejectReason, capturedPageErrorReason, validateCapturedWebsite } from "../src/candidate-validation.js";
import type { WebsiteMetadata } from "../src/types.js";

function capturedTextReason(text: string): string | null {
  return capturedPageErrorReason({
    statusCode: 200,
    title: "Website",
    browserErrors: [],
    visualContext: {
      viewport: { width: 1440, height: 1100 },
      fullPageHeight: 900,
      backgroundColor: "rgb(255, 255, 255)",
      fontFamilies: [],
      headings: [],
      visibleText: [text],
      imageCount: 0,
      buttonCount: 0,
      linkCount: 0,
    },
  });
}

function metadataWithScreenshot(thumbnail: Buffer): WebsiteMetadata {
  return {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    title: "Example",
    description: "",
    siteName: "Example",
    canonicalUrl: "https://example.com/",
    faviconUrl: "",
    contentType: "text/html",
    statusCode: 200,
    browserErrors: [],
    visualContext: {
      viewport: { width: 1440, height: 1100 },
      fullPageHeight: 1100,
      backgroundColor: "rgb(255, 255, 255)",
      fontFamilies: [],
      headings: ["Example"],
      visibleText: ["A polished website with enough visible content for validation."],
      imageCount: 1,
      buttonCount: 1,
      linkCount: 3,
    },
    screenshot: {
      thumbnail,
      fullPage: thumbnail,
      mimeType: "image/jpeg",
    },
  };
}

async function browserErrorLikeScreenshot(): Promise<Buffer> {
  const blackBlock = async (width: number, height: number) =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: "#111111",
      },
    })
      .jpeg()
      .toBuffer();

  return sharp({
    create: {
      width: 640,
      height: 960,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: await blackBlock(42, 42), left: 42, top: 42 },
      { input: await blackBlock(410, 32), left: 40, top: 145 },
      { input: await blackBlock(280, 22), left: 40, top: 205 },
      { input: await blackBlock(78, 40), left: 40, top: 280 },
      { input: await blackBlock(70, 40), left: 140, top: 280 },
    ])
    .jpeg()
    .toBuffer();
}

async function normalWebsiteScreenshot(): Promise<Buffer> {
  return sharp({
    create: {
      width: 640,
      height: 960,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 560,
            height: 360,
            channels: 3,
            background: "#0d47ff",
          },
        })
          .jpeg()
          .toBuffer(),
        left: 40,
        top: 260,
      },
      {
        input: await sharp({
          create: {
            width: 360,
            height: 42,
            channels: 3,
            background: "#111111",
          },
        })
          .jpeg()
          .toBuffer(),
        left: 40,
        top: 90,
      },
    ])
    .jpeg()
    .toBuffer();
}

test("rejects curator subdomain asset hosts", () => {
  assert.equal(
    candidateRejectReason("https://thumb.craftwork.design/example.jpg", new Set(["craftwork.design"])),
    "curator host",
  );
});

test("rejects Product Hunt candidates", () => {
  assert.equal(candidateRejectReason("https://www.producthunt.com/products/craftwork-design"), "blocked host");
});

test("allows real website candidates", () => {
  assert.equal(candidateRejectReason("https://aave.com/"), null);
});

test("rejects captured client-side application error pages", () => {
  assert.equal(
    capturedTextReason("Application error: a client-side exception has occurred (see the browser console for more information)."),
    "client-side application error",
  );
});

test("rejects access and bot protection pages", () => {
  assert.equal(capturedTextReason("Just a moment... Checking if the site connection is secure."), "bot protection page");
  assert.equal(capturedTextReason("Access denied. You don't have permission to access this page."), "access denied page");
  assert.equal(capturedTextReason("Verify you are human before continuing."), "captcha page");
  assert.equal(capturedTextReason("Please enable JavaScript to continue."), "javascript required page");
  assert.equal(capturedTextReason("ERR_CONNECTION_TIMED_OUT"), "browser error page");
});

test("rejects failed HTTP responses", () => {
  assert.equal(
    capturedPageErrorReason({
      statusCode: 500,
      title: "Internal Server Error",
      browserErrors: [],
      visualContext: {
        viewport: { width: 1440, height: 1100 },
        fullPageHeight: 900,
        backgroundColor: "rgb(255, 255, 255)",
        fontFamilies: [],
        headings: ["Internal Server Error"],
        visibleText: [],
        imageCount: 0,
        buttonCount: 0,
        linkCount: 0,
      },
    }),
    "http 500",
  );
});

test("rejects browser error screenshots", async () => {
  assert.equal(await validateCapturedWebsite(metadataWithScreenshot(await browserErrorLikeScreenshot())), "browser error screenshot");
});

test("keeps normal high-contrast website screenshots valid", async () => {
  assert.equal(await validateCapturedWebsite(metadataWithScreenshot(await normalWebsiteScreenshot())), null);
});
