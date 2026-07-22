// Tests for the /ask fallbacks.
//
// /ask used to throw and return 502 whenever LLM_URL was unset, which is the
// default state on a fresh install. Both halves of the pipeline (planning and
// summarising) now degrade instead: keyword routing picks a service, and a
// deterministic summary replaces the narrated answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordPlan, summarizeWithoutLlm } from "../src/ask.ts";

test("keywordPlan falls back to broca's own feed for unrecognised questions", () => {
  const plan = keywordPlan("what on earth is going on");
  assert.equal(plan.service, "broca");
  assert.equal(plan.path, "/feed");
});

test("keywordPlan does not route to an unconfigured service", () => {
  // No CHIASM_URL is set in the test environment, so a task question must
  // still fall back to the feed rather than planning a call that cannot work.
  const plan = keywordPlan("show me the tasks");
  assert.equal(plan.service, "broca");
});

test("summarizeWithoutLlm prefers a human-readable field", () => {
  const out = summarizeWithoutLlm(
    { service: "broca", method: "GET", path: "/feed", params: {}, body: null },
    [{ id: 1, narrative: "gir ate a taco" }, { id: 2, narrative: "gir made waffles" }],
  );
  assert.match(out, /2 result\(s\)/);
  assert.match(out, /gir ate a taco/);
  assert.match(out, /gir made waffles/);
});

test("summarizeWithoutLlm unwraps common envelope shapes", () => {
  const out = summarizeWithoutLlm(
    { service: "chiasm", method: "GET", path: "/tasks", params: {}, body: null },
    { tasks: [{ id: 7, title: "ship it" }] },
  );
  assert.match(out, /ship it/);
});

test("summarizeWithoutLlm reports emptiness rather than inventing an answer", () => {
  const out = summarizeWithoutLlm(
    { service: "broca", method: "GET", path: "/feed", params: {}, body: null },
    [],
  );
  assert.match(out, /No results/);
});

test("summarizeWithoutLlm truncates long result sets and says how many remain", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, narrative: `event ${i}` }));
  const out = summarizeWithoutLlm(
    { service: "broca", method: "GET", path: "/feed", params: {}, body: null },
    rows,
  );
  assert.match(out, /and 15 more/);
});

test("summarizeWithoutLlm falls back to key summary when no readable field exists", () => {
  const out = summarizeWithoutLlm(
    { service: "axon", method: "GET", path: "/events", params: {}, body: null },
    [{ foo: "bar", baz: 1 }],
  );
  assert.match(out, /foo=bar/);
});
