import { expect, test } from "bun:test";
import { canonicalIntentFor, createAdapter, urlRecognizer } from "../src/adapters/index.ts";
import { DEFAULT_FILTER, type Config } from "../src/core/config.ts";
import { parseIntent } from "../src/core/intent.ts";

const config: Config = {
  instances: [
    { id: "github", type: "github", url: "https://api.github.com", user: "lapo", emails: [] },
    { id: "kde", type: "gitlab", url: "https://invent.kde.org/api/v4", user: "lapo", emails: [] },
    { id: "codeberg", type: "forgejo", url: "https://codeberg.org/api/v1", user: "lapo", emails: [] },
    { id: "freebsd", type: "bugzilla", url: "https://bugs.freebsd.org/bugzilla", user: "lapo@example.org", emails: [] },
    { id: "broken", type: "gitlab", url: "not a url", user: "lapo", emails: [] },
  ],
  filter: DEFAULT_FILTER,
  commitBranch: "config",
};

test("createAdapter knows every instance type", () => {
  for (const inst of config.instances.slice(0, 4)) expect(createAdapter(inst)).toBeDefined();
});

test("urlRecognizer canonicalizes URLs of every forge and skips misconfigured instances", () => {
  const recognize = urlRecognizer(config);
  expect(recognize("https://github.com/foo/bar/pull/42/files")).toEqual({
    url: "https://github.com/foo/bar/pull/42", instance: "github", kind: "pr",
  });
  expect(recognize("https://invent.kde.org/utilities/konsole/-/merge_requests/7/diffs")?.url)
    .toBe("https://invent.kde.org/utilities/konsole/-/merge_requests/7");
  expect(recognize("https://codeberg.org/foo/bar/issues/3#issuecomment-1")?.url).toBe("https://codeberg.org/foo/bar/issues/3");
  expect(recognize("https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=123#c4")?.url)
    .toBe("https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=123");
  expect(recognize("https://gitlab.com/foo/bar/-/issues/3")).toBeNull(); // no gitlab.com instance
});

test("canonicalIntentFor re-keys items.yaml by canonical URL", () => {
  const raw = parseIntent(`
items:
  - url: https://github.com/foo/bar/pull/42/
    priority: important
  - url: https://gitlab.com/foo/bar/-/issues/3
`);
  const { intent, unknown } = canonicalIntentFor(config, raw);
  expect([...intent.keys()]).toEqual(["https://github.com/foo/bar/pull/42"]);
  expect(unknown).toEqual(["https://gitlab.com/foo/bar/-/issues/3"]);
});
