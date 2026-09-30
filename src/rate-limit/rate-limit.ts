import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface RateLimitInfo {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitInfo> | RateLimitInfo;
  reset(key: string): Promise<void> | void;
}

export function memoryRateLimitStore(): RateLimitStore {
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
}

function clientKey(request: Request): string {
  const ip = (request as { ip?: string }).ip;
  if (ip !== undefined && ip !== "") return ip;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) return forwarded.split(",")[0]!.trim();
  return "global";
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
  const keyOf = options.keyOf ?? clientKey;

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
      ctx.response.status = 429;
      ctx.response.headers.set("retry-after", String(verdict.resetSeconds));
      ctx.response.headers.set("content-type", "application/json");
      ctx.response.body = JSON.stringify({ success: false, status: 429, message });
      return;
    }
    await next();
  };
}

export type RateLimitWsMiddleware = <THooks extends object>(
  request: Request,
  next: () => Promise<THooks>,
) => Promise<THooks | Response>;

export function rateLimitWs(options: RateLimitOptions = {}): RateLimitWsMiddleware {
  const withHeaders = options.headers ?? true;
  const message = options.message ?? "Too Many Requests";
  const skip = options.skip;
  const check = createLimiter(options);

  return async (request, next) => {
    if (skip !== undefined && (await skip(request))) return next();
    const verdict = await check(request);
    if (verdict.allowed) return next();
    const headers = new Headers({
      "content-type": "application/json",
      "retry-after": String(verdict.resetSeconds),
    });
    if (withHeaders) {
      headers.set("ratelimit-limit", String(verdict.limit));
      headers.set("ratelimit-remaining", String(verdict.remaining));
      headers.set("ratelimit-reset", String(verdict.resetSeconds));
    }
    return new Response(JSON.stringify({ success: false, status: 429, message }), { status: 429, headers });
  };
}
