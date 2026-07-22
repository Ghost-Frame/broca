// Regression guard for the dashboard XSS fix.
//
// The recent-activity feed renders `narrative` and `action` text that arrives
// via POST /ingest, which is deliberately unauthenticated. Building those rows
// with innerHTML let any ingested payload inject markup into the dashboard.
// They must be built with textContent instead.
//
// UI_HTML is a template string rather than a DOM, so these assertions work on
// the emitted source: the safe construction must be present, and the unsafe
// interpolation must not reappear.

import { test } from "node:test";
import assert from "node:assert/strict";
import { UI_HTML } from "../src/ui.ts";

test("feed rows are built with textContent, not innerHTML", () => {
  assert.ok(
    UI_HTML.includes("textSpan.textContent = e.narrative || e.action"),
    "feed row text should be assigned via textContent",
  );
  assert.ok(
    UI_HTML.includes("timeSpan.textContent = timeAgo(e.created_at)"),
    "feed row timestamp should be assigned via textContent",
  );
});

test("no innerHTML assignment interpolates ingested content", () => {
  // Substitution only happens inside template literals, so a backtick-delimited
  // assignment containing ${...} is the dangerous form. String concatenation
  // onto innerHTML is the other. The one innerHTML left in the file is a static
  // single-quoted spinner with neither, which both patterns allow.
  const templateInterpolation = /innerHTML\s*=\s*`[^`]*\$\{/;
  const stringConcatenation = /innerHTML\s*=\s*[^;`\n]*['"]\s*\+/;

  assert.equal(
    templateInterpolation.test(UI_HTML),
    false,
    "innerHTML must not be assigned an interpolated template literal",
  );
  assert.equal(
    stringConcatenation.test(UI_HTML),
    false,
    "innerHTML must not be assigned a concatenated string",
  );
});

test("narrative and action are never concatenated into markup", () => {
  assert.equal(
    /innerHTML[^\n]*e\.narrative/.test(UI_HTML),
    false,
    "narrative must not reach innerHTML",
  );
});
