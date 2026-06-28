import assert from "node:assert/strict";
import test from "node:test";
import { candidateRejectReason, capturedPageErrorReason } from "../src/candidate-validation.js";

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
