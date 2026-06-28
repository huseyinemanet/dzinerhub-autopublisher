import assert from "node:assert/strict";
import test from "node:test";
import { isUsefulStoryUrl, normalizeStoryClassification, parseJsonContent, tinyStoryBlurb } from "../src/stories.js";

const fallback = {
  title: "Fallback Title",
  ogTitle: "",
  description: "Fallback description",
  finalUrl: "https://example.com/story",
};

test("rejects story utility and navigation URLs before AI classification", () => {
  assert.equal(isUsefulStoryUrl("mailto:hello@example.com", "https://news.ycombinator.com/"), false);
  assert.equal(isUsefulStoryUrl("https://example.com/image.jpg", "https://news.ycombinator.com/"), false);
  assert.equal(isUsefulStoryUrl("https://news.ycombinator.com/newest", "https://news.ycombinator.com/"), false);
  assert.equal(isUsefulStoryUrl("https://pudding.cool/2026/06/menu-collection/", "https://news.ycombinator.com/"), true);
});

test("parses JSON even when model wraps it in surrounding text", () => {
  assert.deepEqual(parseJsonContent('Sure:\n{"title":"A","qualityScore":0.9}\nThanks'), {
    title: "A",
    qualityScore: 0.9,
  });
});

test("normalizes loose AI story output into short display fields", () => {
  const normalized = normalizeStoryClassification(
    {
      title: "A very long title ".repeat(20),
      summary: "A concise article about design systems and product judgment.",
      blurb:
        "A must-read deep dive that is far too long for the Stories list and should be compressed before display.",
      tags: "design, ai, product",
      score: "0.91",
      publish: "true",
    },
    fallback,
  );

  assert.equal(normalized.shouldPublish, true);
  assert.equal(normalized.qualityScore, 0.91);
  assert.ok(normalized.title.length <= 140);
  assert.ok(normalized.description.length <= 90);
  assert.ok(normalized.aiComment.length <= 80);
  assert.deepEqual(normalized.tags, ["Design", "AI", "Product"]);
});

test("tinyStoryBlurb removes hype and stays compact", () => {
  const blurb = tinyStoryBlurb("A must-read fascinating deep dive into AI-assisted software judgment for modern teams.");

  assert.ok(blurb.length <= 80);
  assert.equal(/\bmust-read|fascinating|deep dive\b/i.test(blurb), false);
});
