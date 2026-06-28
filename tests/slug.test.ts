import assert from "node:assert/strict";
import test from "node:test";
import { addExistingIdentity, createWebsiteIdentityIndex, uniqueSlugForCandidate } from "../src/dedupe.js";
import { slugForWebsite } from "../src/slug.js";
import type { CandidateResult } from "../src/types.js";

function candidate(slug: string, url: string): CandidateResult {
  return {
    sourceUrl: url,
    metadata: {
      url,
      finalUrl: url,
      canonicalUrl: url,
      title: "Example",
      description: "",
      siteName: "Example",
      faviconUrl: "",
      contentType: "text/html",
      visualContext: {
        viewport: { width: 1440, height: 1100 },
        fullPageHeight: 1100,
        backgroundColor: "rgb(255, 255, 255)",
        fontFamilies: [],
        headings: [],
        visibleText: [],
        imageCount: 0,
        buttonCount: 0,
        linkCount: 0,
      },
      screenshot: {
        thumbnail: Buffer.from([]),
        fullPage: Buffer.from([]),
        mimeType: "image/jpeg",
      },
    },
    classification: {
      title: "Example",
      longTitle: "Example",
      comment: "Example",
      categories: [],
      types: [],
      platforms: [],
      styles: [],
      typographies: [],
      qualityScore: 1,
      shouldPublish: true,
    },
    aiComment: "",
    slug,
    externalLink: url,
  };
}

test("uses URL-derived slug for generic titles", () => {
  assert.equal(slugForWebsite("Home", "https://example.com/product/page"), "example-product-page");
});

test("adds deterministic suffix when slug already exists for a different URL", () => {
  const index = createWebsiteIdentityIndex();
  addExistingIdentity(index, "example", ["https://first.example.com"]);

  const nextSlug = uniqueSlugForCandidate(index, candidate("example", "https://second.example.com"));

  assert.match(nextSlug, /^example-[a-f0-9]{8}$/);
  assert.notEqual(nextSlug, "example");
});
