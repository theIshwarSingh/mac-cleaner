import assert from "node:assert/strict";
import { test } from "node:test";
import { expandHome, findingId, humanBytes, tildify, HOME } from "./util.js";

test("humanBytes uses decimal units", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(999), "999 B");
  assert.equal(humanBytes(1500), "1.5 KB");
  assert.equal(humanBytes(2_400_000_000), "2.4 GB");
});

test("findingId is stable and scoped", () => {
  assert.equal(findingId("cleanup", "logs", "/a"), findingId("cleanup", "logs", "/a"));
  assert.notEqual(findingId("cleanup", "logs", "/a"), findingId("cleanup", "user-caches", "/a"));
  assert.equal(findingId("cleanup", "logs", "/a").length, 16);
});

test("home expansion round-trips", () => {
  assert.equal(expandHome("~/x"), `${HOME}/x`);
  assert.equal(tildify(`${HOME}/x`), "~/x");
  assert.equal(expandHome("/abs"), "/abs");
});
