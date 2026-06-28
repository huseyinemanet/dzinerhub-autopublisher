import assert from "node:assert/strict";
import test from "node:test";
import { candidateRejectReason } from "../src/candidate-validation.js";

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
