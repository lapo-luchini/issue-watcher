// Signal/noise classification. A pure function, so it can later be replaced or
// backed up by another classifier (e.g. an LLM) without touching the poller.
import type { NormalizedEvent, Priority, Verdict } from "./model.ts";

export interface FilterConfig {
  noisePatterns: string[];
  minCommentLength: number;
  botAllowlist: string[];
}

/** Event kinds that only matter on important items. */
const IMPORTANT_ONLY = new Set(["ci", "push", "conflict"]);
/** Noise patterns only apply to short comments, so a long, substantive comment starting with "Any update" still counts. */
const PATTERN_MAX_LENGTH = 100;
const KNOWN_BOTS = new Set([
  "stale", "github-actions", "dependabot", "renovate", "codecov", "coveralls",
  "netlify", "vercel", "sonarcloud", "gitlab-bot", "forgejo-actions",
]);

export function isBot(actor: string): boolean {
  const a = actor.toLowerCase();
  return a.endsWith("[bot]") || a.endsWith("-bot") || KNOWN_BOTS.has(a);
}

/** Lowercase, drop punctuation (keeping '+'), collapse whitespace. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}+\s]/gu, "").replace(/\s+/g, " ").trim();
}

/** True when the body has no words or digits: only emoji, :shortcodes:, punctuation, whitespace. */
export function isEmojiOnly(s: string): boolean {
  const stripped = s
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu, "");
  return !/[\p{L}\p{N}]/u.test(stripped);
}

const signal = (why: string): Verdict => ({ isSignal: true, reason: `signal:${why}` });
const noise = (why: string): Verdict => ({ isSignal: false, reason: `noise:${why}` });

export function classify(ev: NormalizedEvent, priority: Priority, cfg: FilterConfig): Verdict {
  if (ev.actorRole === "me") return noise("own");
  // Logins are case-insensitive on every forge (Bugzilla reports e.g. "bugzilla@FreeBSD.org").
  const allowed = cfg.botAllowlist.some((b) => b.toLowerCase() === ev.actor.toLowerCase());
  const bot = (ev.actorRole === "bot" || isBot(ev.actor)) && !allowed;
  if (IMPORTANT_ONLY.has(ev.kind)) {
    return priority === "important" ? signal(ev.kind) : { isSignal: false, reason: `low-priority:${ev.kind}` };
  }
  switch (ev.kind) {
    case "comment":
      return classifyComment(ev, bot, cfg);
    case "review":
      return bot ? noise("bot") : signal("review");
    case "label":
    case "milestone":
      return ev.actorRole === "maintainer" && !bot ? signal(ev.kind) : noise(`${ev.kind}-by-non-maintainer`);
    case "assign":
      // Bugzilla reports every assignee change (with `to`), and automation assigning on its own
      // (FreeBSD auto-assigns ports PRs) is not news. Elsewhere `assign` means "I was assigned",
      // which counts even when a triage bot did it.
      return bot && ev.details?.to ? noise("bot") : signal("assign");
    case "flag":
      // A bot *requesting* a flag (e.g. "maintainer-feedback?" on every new ports PR) is routine;
      // a granted or denied flag (+/-) is news even when a bot relays it.
      return bot && isFlagRequest(ev) ? noise("bot") : signal("flag");
    default:
      return signal(ev.kind);
  }
}

/** Bugzilla flag requests look like "review?" or "needinfo?(someone@example.org)". */
function isFlagRequest(ev: NormalizedEvent): boolean {
  return ev.details?.action === "added" && /\?(\(|$)/.test(String(ev.details?.flag ?? ""));
}

function classifyComment(ev: NormalizedEvent, bot: boolean, cfg: FilterConfig): Verdict {
  if (bot) return noise("bot");
  if (ev.actorRole === "maintainer") return signal("maintainer-comment");
  const body = ev.body ?? "";
  if (isEmojiOnly(body)) return noise("emoji");
  const text = normalizeText(body);
  if (text.length <= PATTERN_MAX_LENGTH) {
    for (const p of cfg.noisePatterns) if (new RegExp(p, "i").test(text)) return noise(`pattern:${p}`);
  }
  if (text.length < cfg.minCommentLength) return noise("short");
  return signal("comment");
}
