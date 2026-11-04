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
  expect(cfg.instances[0]).toEqual({ id: "github", type: "github", url: "https://api.github.com", user: "lapo", token: "dummy" });
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
});
