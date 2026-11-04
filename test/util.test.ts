import { expect, test } from "bun:test";
import { mentions, notGone, optional, parseUrl } from "../src/adapters/util.ts";
import { GoneError, HttpError, RateLimitError } from "../src/core/http.ts";

test("mentions matches whole logins only", () => {
  expect(mentions("thanks @lapo!", "lapo")).toBe(true);
  expect(mentions("@Lapo please look", "lapo")).toBe(true);
  expect(mentions("cc @lapo, @other", "lapo")).toBe(true);
  expect(mentions("thanks @lapo.", "lapo")).toBe(true); // a dot ending the sentence
  expect(mentions("@lapo.luchini is someone else", "lapo")).toBe(false); // logins may contain dots
  expect(mentions("@lapo-l is someone else", "lapo")).toBe(false);
  expect(mentions("@lapoluchini", "lapo")).toBe(false);
  expect(mentions("mail me at x@lapo.org", "lapo")).toBe(false);
  expect(mentions("no mention", "lapo")).toBe(false);
  expect(mentions("@a.b+c", "a.b+c")).toBe(true); // regex characters in logins are literal
  expect(mentions("@axb+c", "a.b+c")).toBe(false);
});

test("notGone turns a 404 into an ordinary failure", async () => {
  const err = await notGone(Promise.reject(new GoneError(404, "u"))).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).not.toBeInstanceOf(GoneError);
  expect(await notGone(Promise.resolve(1))).toBe(1);
});

test("optional swallows 403/404 only", async () => {
  expect(await optional(Promise.reject(new HttpError(403, "u")))).toBeNull();
  expect(await optional(Promise.reject(new GoneError(404, "u")))).toBeNull();
  await expect(optional(Promise.reject(new RateLimitError(403, "u", null)))).rejects.toBeInstanceOf(RateLimitError);
  await expect(optional(Promise.reject(new HttpError(500, "u")))).rejects.toBeInstanceOf(HttpError);
});

test("parseUrl", () => {
  expect(parseUrl("https://a/b")?.host).toBe("a");
  expect(parseUrl("nope")).toBeNull();
});
