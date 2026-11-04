import { expect, test } from "bun:test";
import { summarize } from "../src/core/summary.ts";

test("summaries", () => {
  expect(summarize({ kind: "comment", actor: "bob", excerpt: "Looks  good\nbut please\trebase", details: null }))
    .toBe("comment by @bob: Looks good but please rebase");
  expect(summarize({ kind: "review", actor: "m", excerpt: "", details: { state: "changes_requested" } }))
    .toBe("review (changes_requested) by @m");
  expect(summarize({ kind: "state", actor: "m", excerpt: null, details: { to: "merged" } })).toBe("→ merged by @m");
  expect(summarize({ kind: "label", actor: "m", excerpt: null, details: { action: "removed", label: "wip" } }))
    .toBe("label -wip by @m");
  expect(summarize({ kind: "ci", actor: "", excerpt: null, details: { from: "success", to: "failure" } })).toBe("CI → failure");
  expect(summarize({ kind: "review_request", actor: "m", excerpt: null, details: null })).toBe("review request by @m");
});
