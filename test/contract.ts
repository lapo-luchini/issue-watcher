// Checks every adapter must pass, called from each adapter's test file with its own fake API.
import { expect } from "bun:test";
import type { Adapter, ItemRef } from "../src/core/model.ts";

const ROLES = ["me", "maintainer", "contributor", "bot", "unknown"];

/** Fetches `ref` twice and checks the invariants the poller relies on. */
export async function expectAdapterContract(adapter: Adapter, ref: ItemRef): Promise<void> {
  // Canonical URLs are fixed points, so items.yaml and the cache always agree on the key.
  expect(adapter.refFromUrl(ref.url)).toEqual(ref);
  const first = await adapter.fetch(ref);
  const second = await adapter.fetch(ref);
  expect(first.ref).toEqual(ref);
  const keys = first.events.map((e) => e.key);
  // Keys are unique within the item and stable across fetches: dedup depends on it.
  expect(new Set(keys).size).toBe(keys.length);
  expect(second.events.map((e) => e.key)).toEqual(keys);
  for (const e of first.events) {
    expect(Number.isNaN(e.at.getTime())).toBe(false);
    expect(e.at.getTime()).toBeGreaterThan(0);
    expect(ROLES).toContain(e.actorRole);
  }
}
