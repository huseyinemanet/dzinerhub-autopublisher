import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWebsiteCategories,
  normalizeWebsiteCategoryName,
  WEBSITE_CATEGORY_TITLES,
} from "../src/website-categories.js";

test("keeps only fixed website page-type categories", () => {
  assert.deepEqual(normalizeWebsiteCategories(["Web Design", "Fintech", "Landing Page"]), ["Landing Page"]);
  assert.equal(normalizeWebsiteCategoryName("Branding"), null);
  assert.equal(normalizeWebsiteCategoryName("AI"), null);
});

test("infers landing page for SaaS and software metadata", () => {
  assert.deepEqual(
    normalizeWebsiteCategories([], {
      title: "Acme",
      types: ["SaaS", "Software"],
      comment: "A marketing website for a modern SaaS platform.",
    }),
    ["Product Page", "Landing Page"],
  );
});

test("infers portfolio from agency or personal metadata", () => {
  assert.deepEqual(
    normalizeWebsiteCategories([], {
      title: "North Studio",
      types: ["Agency"],
      comment: "Independent creative studio portfolio.",
    }),
    ["Portfolio"],
  );
});

test("falls back to Other when no fixed page type is supported", () => {
  assert.deepEqual(
    normalizeWebsiteCategories(["Typography", "Branding"], {
      title: "Signal",
      comment: "Elegant visual identity work.",
    }),
    ["Other"],
  );
});

test("exposes the exact fixed taxonomy", () => {
  assert.deepEqual(WEBSITE_CATEGORY_TITLES, [
    "Landing Page",
    "Portfolio",
    "Blog",
    "E-commerce",
    "Product Page",
    "Product Listing",
    "Pricing Page",
    "About Us",
    "Career",
    "Sign Up",
    "Made in Framer",
    "Other",
  ]);
});
