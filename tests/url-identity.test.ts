import assert from "node:assert/strict";
import test from "node:test";
import { canonicalUrlKey } from "../src/url-identity.js";

test("normalizes exact-page URL identity across protocol, www, slash, and tracking params", () => {
  const base = canonicalUrlKey("https://aave.com");

  assert.equal(canonicalUrlKey("https://www.aave.com/"), base);
  assert.equal(canonicalUrlKey("http://aave.com/?ref=dzinerhub.com&utm_source=x"), base);
  assert.equal(canonicalUrlKey("https://aave.com/#hero"), base);
});

test("keeps different paths on the same domain distinct", () => {
  assert.notEqual(canonicalUrlKey("https://apple.com/"), canonicalUrlKey("https://apple.com/iphone-17e/"));
});
