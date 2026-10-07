import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export interface CorsOptions {
  origin?: string | string[] | ((origin: string) => string | null);
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
  credentials?: boolean;
}

function findAllowOrigin(optsOrigin: NonNullable<CorsOptions["origin"]>): (origin: string) => string | null {
  if (typeof optsOrigin === "function") return optsOrigin;
  if (typeof optsOrigin === "string") {
    if (optsOrigin === "*") return () => optsOrigin;
    return (origin) => (optsOrigin === origin ? origin : null);
  }
  return (origin) => (optsOrigin.includes(origin) ? origin : null);
}

export function cors(options: CorsOptions = {}): Middleware<RhythmHttpContext> {
  const opts = {
    origin: "*" as NonNullable<CorsOptions["origin"]>,
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "QUERY"],
    allowHeaders: [] as string[],
    exposeHeaders: [] as string[],
    ...options,
  };
  const allowOriginFor = findAllowOrigin(opts.origin);

  return async (ctx, next) => {
    const { headers } = ctx.response;

    const allowOrigin = allowOriginFor(ctx.request.headers.get("origin") ?? "");
    if (allowOrigin) headers.set("access-control-allow-origin", allowOrigin);

    if (opts.origin !== "*") headers.append("vary", "Origin");
    if (opts.credentials) headers.set("access-control-allow-credentials", "true");
    if (opts.exposeHeaders.length) headers.set("access-control-expose-headers", opts.exposeHeaders.join(","));

    if (ctx.request.method === "OPTIONS") {
      if (opts.maxAge !== undefined) headers.set("access-control-max-age", opts.maxAge.toString());
      if (opts.allowMethods.length) headers.set("access-control-allow-methods", opts.allowMethods.join(","));

      let allowHeaders = opts.allowHeaders;
      if (!allowHeaders.length) {
        const requested = ctx.request.headers.get("access-control-request-headers");
        if (requested) allowHeaders = requested.split(/\s*,\s*/);
      }
      if (allowHeaders.length) {
        headers.set("access-control-allow-headers", allowHeaders.join(","));
        headers.append("vary", "Access-Control-Request-Headers");
      }

      headers.delete("content-length");
      headers.delete("content-type");
      ctx.response.status = 204;
      ctx.response.statusText = "No Content";
      ctx.response.body = null;
      return;
    }

    await next();
  };
}
