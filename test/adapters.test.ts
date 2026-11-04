import { expect, test } from "bun:test";
import { canonicalIntentFor, urlRecognizer } from "../src/adapters/index.ts";
import { DEFAULT_FILTER, type Config } from "../src/core/config.ts";
import { parseIntent } from "../src/core/intent.ts";

const config: Config = {
  instances: [
    { id: "github", type: "github", url: "https://api.github.com", user: "lapo", emails: [] },
    { id: "gl", type: "gitlab", url: "https://gitlab.com/api/v4", user: "lapo", emails: [] }, // no adapter yet
  ],
  filter: DEFAULT_FILTER,
};

test("urlRecognizer canonicalizes URLs of supported instances and skips the others", () => {
  const recognize = urlRecognizer(config);
  expect(recognize("https://github.com/foo/bar/pull/42/files")).toEqual({
    url: "https://github.com/foo/bar/pull/42", instance: "github", kind: "pr",
  });
  expect(recognize("https://gitlab.com/foo/bar/-/issues/3")).toBeNull();
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
