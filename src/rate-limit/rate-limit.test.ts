import { describe, expect, test } from "bun:test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import {
  memoryRateLimitStore,
  rateLimit,
  rateLimitWs,
  type RateLimitInfo,
  type RateLimitOptions,
  type RateLimitStore,
} from "./rate-limit";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const app = (options?: RateLimitOptions) =>
  serve(
    new RhythmRouter().use(rateLimit(options)).get("/data", (ctx) => {
      ctx.response.body = "ok";
    }),
  );

const get = (headers: Record<string, string> = {}) => new Request("http://localhost/data", { headers });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("rateLimit", () => {
  test("allows requests under the limit and blocks the ones over it", async () => {
    const handler = app({ limit: 2 });

    expect((await handler(get())).status).toBe(200);
    expect((await handler(get())).status).toBe(200);

    const blocked = await handler(get());
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ success: false, status: 429, message: "Too Many Requests" });
  });

  test("sets RateLimit headers on every response and Retry-After on 429", async () => {
    const handler = app({ limit: 1, windowMs: 60_000 });

    const first = await handler(get());
    expect(first.headers.get("ratelimit-limit")).toBe("1");
    expect(first.headers.get("ratelimit-remaining")).toBe("0");
    expect(Number(first.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
    expect(first.headers.get("retry-after")).toBeNull();

    const blocked = await handler(get());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("omits headers when headers is false", async () => {
    const handler = app({ limit: 1, headers: false });

    const first = await handler(get());
    expect(first.headers.get("ratelimit-limit")).toBeNull();

    const blocked = await handler(get());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("ratelimit-limit")).toBeNull();
    expect(blocked.headers.get("retry-after")).not.toBeNull();
  });

  test("counts clients separately by x-forwarded-for", async () => {
    const handler = app({ limit: 1 });

    expect((await handler(get({ "x-forwarded-for": "1.1.1.1" }))).status).toBe(200);
    expect((await handler(get({ "x-forwarded-for": "2.2.2.2" }))).status).toBe(200);
    expect((await handler(get({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }))).status).toBe(429);
  });

  test("starts a fresh window after windowMs elapses", async () => {
    const handler = app({ limit: 1, windowMs: 40 });

    expect((await handler(get())).status).toBe(200);
    expect((await handler(get())).status).toBe(429);

    await sleep(60);
    expect((await handler(get())).status).toBe(200);
  });

  test("uses a custom key generator", async () => {
    const handler = app({ limit: 1, keyOf: (request) => request.headers.get("x-api-key") ?? "anonymous" });

    expect((await handler(get({ "x-api-key": "a" }))).status).toBe(200);
    expect((await handler(get({ "x-api-key": "b" }))).status).toBe(200);
    expect((await handler(get({ "x-api-key": "a" }))).status).toBe(429);
  });

  test("skips requests the skip predicate approves", async () => {
    const handler = app({ limit: 1, skip: (request) => request.headers.get("x-internal") === "1" });

    expect((await handler(get())).status).toBe(200);
    expect((await handler(get({ "x-internal": "1" }))).status).toBe(200);
    expect((await handler(get({ "x-internal": "1" }))).status).toBe(200);
    expect((await handler(get())).status).toBe(429);
  });

  test("delegates counting to a custom store", async () => {
    const calls: Array<{ key: string; windowMs: number }> = [];
    const store: RateLimitStore = {
      increment(key, windowMs): RateLimitInfo {
        calls.push({ key, windowMs });
        return { count: 99, resetAt: Date.now() + 1000 };
      },
      reset() {},
    };
    const handler = app({ limit: 5, windowMs: 1234, store });

    const blocked = await handler(get({ "x-forwarded-for": "9.9.9.9" }));
    expect(blocked.status).toBe(429);
    expect(calls).toEqual([{ key: "9.9.9.9", windowMs: 1234 }]);
  });

  test("responds with a custom message", async () => {
    const handler = app({ limit: 0, message: "Slow down" });

    const blocked = await handler(get());
    expect(await blocked.json()).toEqual({ success: false, status: 429, message: "Slow down" });
  });
});

describe("rateLimitWs", () => {
  const upgrade = (headers: Record<string, string> = {}) => new Request("http://localhost/ws", { headers });

  test("allows upgrades under the limit and rejects with 429 over it, RhythmWs.guard-shaped", async () => {
    const guard = rateLimitWs({ limit: 1 });

    expect(await guard(upgrade())).toBeUndefined();

    const rejected = await guard(upgrade());
    expect(rejected).toBeInstanceOf(Response);
    const response = rejected as Response;
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("ratelimit-limit")).toBe("1");
    expect(await response.json()).toEqual({ success: false, status: 429, message: "Too Many Requests" });
  });

  test("skips upgrades the skip predicate approves", async () => {
    const guard = rateLimitWs({ limit: 0, skip: (request) => request.headers.get("x-internal") === "1" });

    expect(await guard(upgrade({ "x-internal": "1" }))).toBeUndefined();
    expect(await guard(upgrade())).toBeInstanceOf(Response);
  });

  test("shares budget with rateLimit through a common store", async () => {
    const store = memoryRateLimitStore();
    const handler = app({ limit: 2, store });
    const guard = rateLimitWs({ limit: 2, store });

    expect((await handler(get({ "x-forwarded-for": "3.3.3.3" }))).status).toBe(200);
    expect(await guard(upgrade({ "x-forwarded-for": "3.3.3.3" }))).toBeUndefined();
    expect(await guard(upgrade({ "x-forwarded-for": "3.3.3.3" }))).toBeInstanceOf(Response);
    expect((await handler(get({ "x-forwarded-for": "3.3.3.3" }))).status).toBe(429);
  });
});

describe("memoryRateLimitStore", () => {
  test("counts per key within a window", async () => {
    const store = memoryRateLimitStore();

    expect((await store.increment("a", 1000)).count).toBe(1);
    expect((await store.increment("a", 1000)).count).toBe(2);
    expect((await store.increment("b", 1000)).count).toBe(1);
  });

  test("reset clears a single key", async () => {
    const store = memoryRateLimitStore();

    await store.increment("a", 1000);
    await store.increment("b", 1000);
    await store.reset("a");

    expect((await store.increment("a", 1000)).count).toBe(1);
    expect((await store.increment("b", 1000)).count).toBe(2);
  });

  test("expires entries after the window", async () => {
    const store = memoryRateLimitStore();

    await store.increment("a", 30);
    await sleep(50);

    expect((await store.increment("a", 30)).count).toBe(1);
  });
});
