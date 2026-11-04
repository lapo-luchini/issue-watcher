import { describe, expect, test } from "bun:test";
import { classify, isEmojiOnly, normalizeText, type FilterConfig } from "../src/core/filter.ts";
import type { ActorRole, EventKind, NormalizedEvent, Priority } from "../src/core/model.ts";

const cfg: FilterConfig = {
  noisePatterns: ["^\\+1$", "^me too", "^same here", "^any update", "^bump$"],
  minCommentLength: 20,
  botAllowlist: ["ci-reporter[bot]"],
};

function ev(kind: EventKind, actorRole: ActorRole, body?: string, actor = "someone"): NormalizedEvent {
  return { key: "k", kind, actor, actorRole, at: new Date("2026-11-01T00:00:00Z"), body };
}

const cases: [string, NormalizedEvent, Priority, boolean, string][] = [
  ["+1 comment", ev("comment", "contributor", "+1"), "important", false, "noise:pattern:^\\+1$"],
  ["+1 with punctuation", ev("comment", "contributor", "+1!"), "important", false, "noise:pattern:^\\+1$"],
  ["emoji only", ev("comment", "contributor", "👍🏻 🎉"), "important", false, "noise:emoji"],
  ["shortcode only", ev("comment", "contributor", ":+1: :tada:"), "important", false, "noise:emoji"],
  ["any update?", ev("comment", "unknown", "Any updates on this?"), "important", false, "noise:pattern:^any update"],
  ["long comment starting with 'any update' counts",
    ev("comment", "contributor", "Any update: I re-tested on 14.1 and the crash persists, backtrace attached below. ".repeat(2)),
    "normal", true, "signal:comment"],
  ["short non-maintainer comment", ev("comment", "contributor", "works for me"), "normal", false, "noise:short"],
  ["short maintainer LGTM", ev("comment", "maintainer", "LGTM"), "normal", true, "signal:maintainer-comment"],
  ["substantive comment", ev("comment", "contributor", "This breaks the build on arm64 with clang 19."), "normal", true, "signal:comment"],
  ["bot comment", ev("comment", "bot", "This issue is stale", "stale[bot]"), "important", false, "noise:bot"],
  ["bot by name only", ev("comment", "unknown", "Coverage report: 87% of lines covered", "codecov"), "important", false, "noise:bot"],
  ["allowlisted bot", ev("comment", "bot", "Build failed on FreeBSD 14 amd64", "ci-reporter[bot]"), "important", true, "signal:comment"],
  ["own comment", ev("comment", "me", "Rebased on main, please take another look."), "important", false, "noise:own"],
  ["review", ev("review", "contributor", ""), "normal", true, "signal:review"],
  ["state change by bot still counts", ev("state", "bot", undefined, "stale[bot]"), "normal", true, "signal:state"],
  ["label by maintainer", ev("label", "maintainer"), "normal", true, "signal:label"],
  ["label by bot", ev("label", "bot", undefined, "github-actions[bot]"), "normal", false, "noise:label-by-non-maintainer"],
  ["CI on important", ev("ci", "unknown"), "important", true, "signal:ci"],
  ["CI on normal", ev("ci", "unknown"), "normal", false, "low-priority:ci"],
  ["push by other on important", ev("push", "contributor"), "important", true, "signal:push"],
  ["own push", ev("push", "me"), "important", false, "noise:own"],
  ["conflict on normal", ev("conflict", "unknown"), "normal", false, "low-priority:conflict"],
  ["bugzilla flag", ev("flag", "maintainer"), "normal", true, "signal:flag"],
  ["flag request by a bot",
    { ...ev("flag", "bot", undefined, "bugzilla@freebsd.org"), details: { action: "added", flag: "maintainer-feedback?(x@y.org)" } },
    "important", false, "noise:bot"],
  ["bare flag request by a bot",
    { ...ev("flag", "bot", undefined, "phab-bot@bmo.tld"), details: { action: "added", flag: "review?" } }, "important", false, "noise:bot"],
  ["flag grant relayed by a bot",
    { ...ev("flag", "bot", undefined, "phab-bot@bmo.tld"), details: { action: "added", flag: "review+" } }, "normal", true, "signal:flag"],
  ["flag request by a person",
    { ...ev("flag", "contributor"), details: { action: "added", flag: "needinfo?(me@x.org)" } }, "normal", true, "signal:flag"],
  ["Bugzilla assignment by a bot",
    { ...ev("assign", "bot", undefined, "bugzilla@freebsd.org"), details: { to: "maintainer@example.org" } }, "normal", false, "noise:bot"],
  ["a bot assigning me (GitHub, GitLab, Forgejo)", ev("assign", "bot", undefined, "triage[bot]"), "normal", true, "signal:assign"],
  ["assignment by a person", ev("assign", "maintainer"), "normal", true, "signal:assign"],
  ["mention", ev("mention", "unknown"), "normal", true, "signal:mention"],
];

describe("classify", () => {
  for (const [name, event, priority, isSignal, reason] of cases) {
    test(name, () => {
      expect(classify(event, priority, cfg)).toEqual({ isSignal, reason });
    });
  }
});

describe("helpers", () => {
  test("normalizeText keeps + and drops punctuation", () => {
    expect(normalizeText("  Any UPDATE??  +1! ")).toBe("any update +1");
  });
  test("isEmojiOnly", () => {
    expect(isEmojiOnly("👍")).toBe(true);
    expect(isEmojiOnly("")).toBe(true);
    expect(isEmojiOnly("+1")).toBe(false);
    expect(isEmojiOnly("ok 👍")).toBe(false);
  });
});
