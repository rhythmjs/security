import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface CsrfOptions {
  origin?: string | string[] | ((origin: string) => boolean);
}

const FORM_CONTENT_TYPE = /^\b(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i;
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function csrf(options: CsrfOptions = {}): Middleware<RhythmHttpContext> {
  const optsOrigin = options.origin;

  const isAllowedOrigin = (origin: string | null, requestUrl: string): boolean => {
    if (origin === null) return false;
    if (optsOrigin === undefined) return origin === new URL(requestUrl).origin;
    if (typeof optsOrigin === "string") return origin === optsOrigin;
    if (typeof optsOrigin === "function") return optsOrigin(origin);
    return optsOrigin.includes(origin);
  };

  return async (ctx, next) => {
    if (
      !SAFE_METHODS.has(ctx.request.method) &&
      FORM_CONTENT_TYPE.test(ctx.request.headers.get("content-type") ?? "") &&
      !isAllowedOrigin(ctx.request.headers.get("origin"), ctx.request.url)
    ) {
      ctx.response.status = 403;
      ctx.response.headers.set("content-type", "application/json");
      ctx.response.body = JSON.stringify({ success: false, status: 403, message: "Forbidden" });
      return;
    }
    await next();
  };
}
