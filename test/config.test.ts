import { expect, test } from "bun:test";
import { DEFAULT_FILTER, parseConfig } from "../src/core/config.ts";

const yaml = `
instances:
  - id: github
    type: github
    url: https://api.github.com/
    user: lapo
    token_env: GITHUB_TOKEN
  - id: freebsd-bz
    type: bugzilla
    url: https://bugs.freebsd.org/bugzilla
    user: lapo@example.org
    token_env: FREEBSD_BZ_KEY
filter:
  min_comment_length: 10
`;

test("parses instances, strips trailing slash, resolves tokens", () => {
  const cfg = parseConfig(yaml, { GITHUB_TOKEN: "dummy" });
  expect(cfg.instances[0]).toEqual({ id: "github", type: "github", url: "https://api.github.com", user: "lapo", emails: [], token: "dummy" });
});

test("missing token disables the instance instead of failing", () => {
  const cfg = parseConfig(yaml, { GITHUB_TOKEN: "dummy" });
  expect(cfg.instances[1]?.disabledReason).toBe("missing FREEBSD_BZ_KEY in .env");
  expect(cfg.instances[1]?.token).toBeUndefined();
});

test("filter defaults are merged with overrides", () => {
  const cfg = parseConfig(yaml, {});
  expect(cfg.filter).toEqual({ ...DEFAULT_FILTER, minCommentLength: 10 });
});

test("validation errors", () => {
  expect(() => parseConfig("instances: 3", {})).toThrow("'instances' must be a list");
  expect(() => parseConfig("instances:\n  - id: a\n    type: svn\n    url: x\n    user: u", {})).toThrow("unknown type 'svn'");
  expect(() => parseConfig("instances:\n  - id: a\n    type: github\n    user: u", {})).toThrow("'url' is required");
  const dup = "instances:\n  - {id: a, type: github, url: x, user: u}\n  - {id: a, type: gitlab, url: y, user: u}";
  expect(() => parseConfig(dup, {})).toThrow("duplicate id 'a'");
  expect(() => parseConfig("instances: []\nfilter:\n  noise_patterns: ['(']", {})).toThrow("invalid noise pattern");
  expect(() => parseConfig("instances:\n  - {id: a, type: github, url: x, user: u, emails: me@x.org}", {}))
    .toThrow("config: instances[0]: 'emails' must be a list of strings");
  expect(() => parseConfig("instances:\n  - {id: a, type: github, url: x, user: u, emails: [3]}", {}))
    .toThrow("config: instances[0]: 'emails' must be a list of strings");
  expect(() => parseConfig("emails: me@x.org\ninstances: []", {})).toThrow("config: 'emails' must be a list of strings");
  expect(() => parseConfig("emails: ['']\ninstances: []", {})).toThrow("config: 'emails' must be a list of strings");
});

test("commit emails: top-level list for all instances, per-instance list replaces it", () => {
  const cfg = parseConfig(`
emails: [me@x.org, Me@Home.example]
instances:
  - {id: a, type: github, url: x, user: u}
  - {id: b, type: gitlab, url: y, user: u, emails: [me@work.example]}
  - {id: c, type: forgejo, url: z, user: u, emails: []}
`, {});
  expect(cfg.instances.map((i) => i.emails)).toEqual([["me@x.org", "Me@Home.example"], ["me@work.example"], []]);
  expect(parseConfig("instances:\n  - {id: a, type: github, url: x, user: u}", {}).instances[0]?.emails).toEqual([]);
});

test("radicle: user may be a list of identities; repos and web are validated", () => {
  const cfg = parseConfig(`
instances:
  - id: seed
    type: radicle
    url: https://seed.radicle.garden/api/v1/
    user: [did:key:z6MkLaptop, did:key:z6MkDesktop]
    repos: [rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5]
    web: https://app.radicle.xyz/nodes/seed.radicle.garden/
  - id: mine
    type: radicle
    url: http://localhost:8080/api/v1
    user: did:key:z6MkLaptop
`, {});
  expect(cfg.instances[0]).toEqual({
    id: "seed", type: "radicle", url: "https://seed.radicle.garden/api/v1", user: "did:key:z6MkLaptop", emails: [],
    users: ["did:key:z6MkLaptop", "did:key:z6MkDesktop"], repos: ["rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5"],
    web: "https://app.radicle.xyz/nodes/seed.radicle.garden",
  });
  expect(cfg.instances[1]).toEqual({ id: "mine", type: "radicle", url: "http://localhost:8080/api/v1", user: "did:key:z6MkLaptop", emails: [] });
  expect(() => parseConfig("instances:\n  - {id: a, type: radicle, url: x, user: did:key:z6MkA, repos: [z3gq]}", {}))
    .toThrow("config: instances[0]: 'z3gq' is not a Radicle repo id (rad:z…)");
  expect(() => parseConfig("instances:\n  - {id: a, type: radicle, url: x, user: did:key:z6MkA, web: 'not a url'}", {}))
    .toThrow("config: instances[0]: 'web' must be an http(s) URL");
  expect(() => parseConfig("instances:\n  - {id: a, type: radicle, url: x, user: []}", {}))
    .toThrow("config: instances[0]: 'user' is required (one identity or a list)");
  // Only Radicle accepts a list.
  expect(() => parseConfig("instances:\n  - {id: a, type: github, url: x, user: [a, b]}", {}))
    .toThrow("config: instances[0]: 'user' is required");
  // Mistakes that would otherwise silently watch nothing.
  const bad = (inst: string) => () => parseConfig(`instances:\n  - {id: a, type: radicle, url: x, ${inst}}`, {});
  expect(bad("user: did:key:z6MkA, repos: []")).toThrow("'repos' is empty: leave it out to watch every repo the node seeds");
  expect(bad("user: lapo")).toThrow("'lapo' is not a Radicle identity (did:key:z6Mk… or z6Mk…)");
  expect(bad("user: did:key:z6MkA, web: 'foo:bar'")).toThrow("'web' must be an http(s) URL");
  expect(() => parseConfig("instances:\n  - {id: a, type: github, url: x, user: u, repos: [rad:z3gq]}", {}))
    .toThrow("config: instances[0]: 'repos' and 'web' are for radicle instances only");
});

test("maintainer_domains: optional, lowercased, leading @ dropped", () => {
  const cfg = parseConfig("instances:\n  - {id: a, type: bugzilla, url: x, user: u, maintainer_domains: [FreeBSD.org, '@kde.org']}", {});
  expect(cfg.instances[0]?.maintainerDomains).toEqual(["freebsd.org", "kde.org"]);
  expect(parseConfig("instances:\n  - {id: a, type: bugzilla, url: x, user: u}", {}).instances[0]?.maintainerDomains).toBeUndefined();
  expect(() => parseConfig("instances:\n  - {id: a, type: bugzilla, url: x, user: u, maintainer_domains: x.org}", {}))
    .toThrow("config: instances[0]: 'maintainer_domains' must be a list of strings");
});
