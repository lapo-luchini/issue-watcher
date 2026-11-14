// What the page shows and how a subscription reads, as plain functions (so they can be tested without a browser).
import type { SubscriptionStatus } from "../src/core/following.ts";

export const DEFAULT_REGISTER = "default";
export type View = "items" | "subscriptions";

const count = new Intl.NumberFormat("en-IE");
const plural = (n: number, one: string, many: string) => `${count.format(n)} ${n === 1 ? one : many}`;

/** The path with `register=` added for any register but default (default is what the server assumes). */
export function withRegister(path: string, register: string): string {
  if (register === DEFAULT_REGISTER) return path;
  return `${path}${path.includes("?") ? "&" : "?"}register=${encodeURIComponent(register)}`;
}

/** The remembered register while it exists; default otherwise. While the list is not known yet the choice stands. */
export function pickRegister(saved: string | null, registers: string[]): string {
  if (!saved) return DEFAULT_REGISTER;
  return registers.length === 0 || registers.includes(saved) ? saved : DEFAULT_REGISTER;
}

export const viewFromHash = (hash: string): View => (hash === "#subscriptions" ? "subscriptions" : "items");

export function scopeText(s: Pick<SubscriptionStatus, "scope" | "exclude">): string {
  if (s.scope === "all") return s.exclude.length ? `Every item of the register except ${count.format(s.exclude.length)}` : "Every item of the register";
  return s.scope.length ? plural(s.scope.length, "item", "items") : "No item followed yet";
}

export function cursorText(s: Pick<SubscriptionStatus, "cursor" | "latest">): string {
  if (s.cursor === null) return "No cursor yet: it starts at the first read";
  return `Read up to update ${count.format(s.cursor)} of ${count.format(s.latest)}`;
}

export function unseenText(s: Pick<SubscriptionStatus, "unseen" | "error">): string {
  if (s.error) return `Cannot tell: ${s.error}`;
  return s.unseen ? `${plural(s.unseen, "unseen update", "unseen updates")}` : "Up to date";
}

/** Those with the most unseen updates first; the others keep their order. */
export const orderSubscriptions = (list: SubscriptionStatus[]): SubscriptionStatus[] => [...list].sort((a, b) => b.unseen - a.unseen);

export const totalUnseen = (list: SubscriptionStatus[]): number => list.reduce((n, s) => n + s.unseen, 0);

/**
 * Runs `ask` and reports its outcome only while `current()` still gives what it gave when asked: an answer
 * for a register that was switched away from meanwhile is dropped, never shown under the new one.
 */
export async function whileCurrent<K, T>(
  current: () => K, ask: () => Promise<T>, done: { ok: (answer: T) => void; fail: (err: Error) => void; always?: () => void },
): Promise<void> {
  const asked = current();
  const still = () => current() === asked;
  try {
    const answer = await ask();
    if (still()) done.ok(answer);
  } catch (err) {
    if (still()) done.fail(err as Error);
  } finally {
    if (still()) done.always?.();
  }
}

/** 24-hour "14:05". */
export const clock = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
