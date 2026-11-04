import { expect, test } from "bun:test";
import { getAllPages, getJson, GoneError, HttpError, nextLink, RateLimitError, type HttpDeps } from "../src/core/http.ts";

/** Builds HttpDeps whose fetch replays `responses` in order and records requested URLs. */
function fakeHttp(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const deps: HttpDeps = {
    fetchFn: async (url) => {
      calls.push(url);
      const r = responses.shift();
      if (!r) throw new Error("no more fake responses");
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retries: 3,
    timeoutMs: 1000,
  };
  return { deps, calls, sleeps };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

test("returns parsed JSON", async () => {
  const { deps } = fakeHttp([json({ a: 1 })]);
  expect((await getJson<{ a: number }>("http://x/", {}, deps)).data).toEqual({ a: 1 });
});

test("retries 5xx and network errors with backoff", async () => {
  const { deps, calls, sleeps } = fakeHttp([new Error("ECONNRESET"), new Response("", { status: 502 }), json([1])]);
  expect((await getJson("http://x/", {}, deps)).data).toEqual([1]);
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([500, 1000]);
});

test("gives up after the retry budget", async () => {
  const { deps } = fakeHttp(Array.from({ length: 4 }, () => new Response("down", { status: 503 })));
  await expect(getJson("http://x/", {}, deps)).rejects.toThrow("HTTP 503");
});

test("404 is GoneError, 4xx is HttpError without retry", async () => {
  await expect(getJson("http://x/", {}, fakeHttp([new Response("", { status: 404 })]).deps)).rejects.toBeInstanceOf(GoneError);
  const { deps, calls } = fakeHttp([new Response("bad", { status: 401 })]);
  await expect(getJson("http://x/", {}, deps)).rejects.toBeInstanceOf(HttpError);
  expect(calls).toHaveLength(1);
});

test("rate limits are reported with their reset time", async () => {
  const res = new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" } });
  try {
    await getJson("http://x/", {}, fakeHttp([res]).deps);
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).resetAt?.getTime()).toBe(1790000000 * 1000);
  }
});

test("nextLink", () => {
  expect(nextLink('<https://a/?page=2>; rel="next", <https://a/?page=5>; rel="last"')).toBe("https://a/?page=2");
  expect(nextLink('<https://a/?page=1>; rel="prev"')).toBeNull();
  expect(nextLink(null)).toBeNull();
});

test("getAllPages follows Link headers and applies pick", async () => {
  const { deps, calls } = fakeHttp([
    json({ items: [1, 2] }, { headers: { link: '<http://x/?page=2>; rel="next"' } }),
    json({ items: [3] }),
  ]);
  expect(await getAllPages<number>("http://x/", {}, deps, (b) => b.items)).toEqual([1, 2, 3]);
  expect(calls).toEqual(["http://x/", "http://x/?page=2"]);
});
