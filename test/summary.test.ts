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

test("summaries of Bugzilla-style events", () => {
  expect(summarize({ kind: "flag", actor: "m", excerpt: null, details: { action: "added", flag: "maintainer-approval+" } }))
    .toBe("flag +maintainer-approval+ by @m");
  expect(summarize({ kind: "flag", actor: "m", excerpt: null, details: { action: "removed", flag: "review?" } }))
    .toBe("flag -review? by @m");
  expect(summarize({ kind: "attachment", actor: "m", excerpt: null, details: { action: "obsoleted", summary: "v1  patch" } }))
    .toBe("attachment obsoleted by @m: v1 patch");
  expect(summarize({ kind: "assign", actor: "m", excerpt: null, details: { to: "x@freebsd.org" } }))
    .toBe("assign → x@freebsd.org by @m");
  expect(summarize({ kind: "assign", actor: "m", excerpt: null, details: null })).toBe("assign by @m");
});
