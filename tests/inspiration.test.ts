import assert from "node:assert/strict";
import test from "node:test";
import { isUsefulInspirationUrl, normalizeInspirationClassification } from "../src/inspiration.js";

const metadata = {
  sourceUrl: "https://www.creativeboom.com/inspiration/example",
  finalUrl: "https://www.creativeboom.com/inspiration/example",
  canonicalUrl: "https://www.creativeboom.com/inspiration/example",
  title: "Fallback Visual Project",
  ogTitle: "Fallback Visual Project",
  description: "A visual project with a strong creative point of view.",
  statusCode: 200,
  headings: [],
  articleText: [],
  visibleText: [],
  imageCandidates: [],
};

test("rejects inspiration home, listing, utility, social, and asset URLs", () => {
  assert.equal(isUsefulInspirationUrl("https://www.creativeboom.com/", "https://www.creativeboom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.creativeboom.com/inspiration/", "https://www.creativeboom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.creativeboom.com/about", "https://www.creativeboom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.instagram.com/example", "https://www.creativeboom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.creativeboom.com/image.jpg", "https://www.creativeboom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.booooooom.com/blog/art/", "https://www.booooooom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.booooooom.com/blog/film/", "https://www.booooooom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.booooooom.com/blog/photo/", "https://www.booooooom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://mymodernmet.com/page/2", "https://mymodernmet.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://academy.mymodernmet.com/courses/mixed-media-painting", "https://mymodernmet.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.itsnicethat.com/media/3d", "https://www.itsnicethat.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.designboom.com/competitions/all/", "https://www.designboom.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.frieze.com/fairs/frieze-seoul/tickets", "https://www.frieze.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.theartnewspaper.com/keywords/art-market", "https://www.theartnewspaper.com/"), false);
  assert.equal(isUsefulInspirationUrl("https://www.artnews.com/c/art-news/news/", "https://www.artnews.com/"), false);
});

test("allows likely visual inspiration article URLs on the same source host", () => {
  assert.equal(
    isUsefulInspirationUrl(
      "https://www.creativeboom.com/inspiration/stuart-jacksons-evolving-art-series-strips-it-back-to-what-matters",
      "https://www.creativeboom.com/inspiration/",
    ),
    true,
  );
  assert.equal(
    isUsefulInspirationUrl(
      "https://www.thisiscolossal.com/2026/06/example-artist-project/",
      "https://www.thisiscolossal.com/",
    ),
    true,
  );
});

test("normalizes inspiration AI output with compact fields", () => {
  const normalized = normalizeInspirationClassification(
    {
      title: "A very long visual project title ".repeat(10),
      tag: "creative tech",
      aiComment: "A stunning compact curator note about a visually rich installation and its material language.",
      aiContent: [
        "This must-see project is worth saving because it shows a clear visual idea rather than a generic trend.",
        "Its most essential quality is the relationship between material, image, and atmosphere.",
      ],
      score: "0.93",
      publish: "true",
    },
    metadata,
  );

  assert.equal(normalized.shouldPublish, true);
  assert.equal(normalized.qualityScore, 0.93);
  assert.equal(normalized.tag, "Creative Tech");
  assert.ok(normalized.title.length <= 150);
  assert.ok(normalized.aiComment.length <= 180);
  assert.equal(normalized.aiContent.length, 2);
  assert.equal(/stunning|must-see|essential/i.test([normalized.aiComment, ...normalized.aiContent].join(" ")), false);
});
