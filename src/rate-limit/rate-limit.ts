import { isIP } from "node:net";
import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export interface RateLimitInfo {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitInfo> | RateLimitInfo;
  reset(key: string): Promise<void> | void;
}

export interface MemoryRateLimitStoreOptions {
  maxKeys?: number;
}

export function memoryRateLimitStore(options: MemoryRateLimitStoreOptions = {}): RateLimitStore {
  const maxKeys = options.maxKeys ?? 10_000;
  const entries = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;

  return {
    increment(key: string, windowMs: number): RateLimitInfo {
      const now = Date.now();
      if (now >= nextSweep) {
        for (const [id, entry] of entries) if (entry.resetAt <= now) entries.delete(id);
        nextSweep = now + windowMs;
      }
      const entry = entries.get(key);
      if (entry === undefined || entry.resetAt <= now) {
        if (entry === undefined && entries.size >= maxKeys) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        entries.delete(key);
        const fresh = { count: 1, resetAt: now + windowMs };
        entries.set(key, fresh);
        return { ...fresh };
      }
      entry.count += 1;
      return { count: entry.count, resetAt: entry.resetAt };
    },
    reset(key: string): void {
      entries.delete(key);
    },
  };
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  store?: RateLimitStore;
  keyOf?: (request: Request) => string | Promise<string>;
  skip?: (request: Request) => boolean | Promise<boolean>;
  headers?: boolean;
  message?: string;
  trustProxy?: boolean | number;
}

function clientKeyOf(trustProxy: boolean | number): (request: Request) => string {
  const hops = trustProxy === true ? 1 : trustProxy === false ? 0 : Math.max(0, Math.trunc(trustProxy));
  return (request) => {
    if (hops > 0) {
      const forwarded = request.headers.get("x-forwarded-for");
      if (forwarded !== null) {
        const entries = forwarded.split(",");
        const entry = entries[Math.max(0, entries.length - hops)]?.trim();
        if (entry !== undefined && isIP(entry) !== 0) return entry;
      }
    }
    const ip = (request as { ip?: string }).ip;
    if (ip !== undefined && ip !== "") return ip;
    throw new Error(
      "rateLimit: cannot identify the client. Expose request.ip, set trustProxy behind a proxy, or pass keyOf.",
    );
  };
}

interface Verdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

function createLimiter(options: RateLimitOptions): (request: Request) => Promise<Verdict> {
  const limit = options.limit ?? 100;
  const windowMs = options.windowMs ?? 60_000;
  const store = options.store ?? memoryRateLimitStore();
  const keyOf = options.keyOf ?? clientKeyOf(options.trustProxy ?? false);

  return async (request) => {
    const info = await store.increment(await keyOf(request), windowMs);
    return {
      allowed: info.count <= limit,
      limit,
      remaining: Math.max(0, limit - info.count),
      resetSeconds: Math.max(0, Math.ceil((info.resetAt - Date.now()) / 1000)),
    };
  };
}

export function rateLimit(options: RateLimitOptions = {}): Middleware<RhythmHttpContext> {
  const withHeaders = options.headers ?? true;
  const message = options.message ?? "Too Many Requests";
  const skip = options.skip;
  const check = createLimiter(options);

  return async (ctx, next) => {
    if (skip !== undefined && (await skip(ctx.request))) {
      await next();
      return;
    }
    const verdict = await check(ctx.request);
    if (withHeaders) {
      ctx.response.headers.set("ratelimit-limit", String(verdict.limit));
      ctx.response.headers.set("ratelimit-remaining", String(verdict.remaining));
      ctx.response.headers.set("ratelimit-reset", String(verdict.resetSeconds));
    }
    if (!verdict.allowed) {
      ctx.response.headers.set("retry-after", String(verdict.resetSeconds));
      ctx.json({ success: false, status: 429, message }, 429);
      return;
    }
    await next();
  };
}

export interface RateLimitWsContext {
  readonly request: Request;
  response: Response | undefined;
}

export type RateLimitWsMiddleware = (ctx: RateLimitWsContext, next: () => Promise<unknown>) => Promise<void>;

export function rateLimitWs(options: RateLimitOptions = {}): RateLimitWsMiddleware {
  const withHeaders = options.headers ?? true;
  const message = options.message ?? "Too Many Requests";
  const skip = options.skip;
  const check = createLimiter(options);

  return async (ctx, next) => {
    if (skip !== undefined && (await skip(ctx.request))) {
      await next();
      return;
    }
    const verdict = await check(ctx.request);
    if (verdict.allowed) {
      await next();
      return;
    }
    const headers = new Headers({
      "content-type": "application/json",
      "retry-after": String(verdict.resetSeconds),
    });
    if (withHeaders) {
      headers.set("ratelimit-limit", String(verdict.limit));
      headers.set("ratelimit-remaining", String(verdict.remaining));
      headers.set("ratelimit-reset", String(verdict.resetSeconds));
    }
    ctx.response = new Response(JSON.stringify({ success: false, status: 429, message }), { status: 429, headers });
  };
}
