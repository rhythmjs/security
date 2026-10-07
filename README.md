# @rhythmjs/security

Security middleware for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework:
CORS, CSRF protection, rate limiting, and secure headers.

Everything here is ordinary Rhythm middleware over the HTTP context from `@rhythmjs/router`. Edge concerns
(`secureHeaders`, `cors`) go on the `Rhythm` app, in front of the mounted router; request-gating concerns
(`csrf`, `rateLimit`) go on a router or on individual routes. Each module has its own subpath export; there is no root export.

## Install

```sh
bun add @rhythmjs/security @rhythmjs/rhythm @rhythmjs/router
```

`@rhythmjs/rhythm` and `@rhythmjs/router` are peer dependencies (`>=0.0.18` each). Bun `>=1.2.0` is required.

## Use it with Rhythm

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { cors } from "@rhythmjs/security/cors";
import { csrf } from "@rhythmjs/security/csrf";
import { rateLimit } from "@rhythmjs/security/rate-limit";
import { secureHeaders } from "@rhythmjs/security/secure-headers";

const api = new RhythmRouter()
  .use(csrf())
  .use(rateLimit({ limit: 100, windowMs: 60_000 }))
  .get("/hello", (ctx) => {
    ctx.json({ hello: "world" });
  })
  .post("/messages", async (ctx) => {
    ctx.json(await ctx.request.json(), 201);
  });

const app = new Rhythm<{}, RhythmHttpContext>()
  .use(secureHeaders())
  .use(cors({ origin: ["https://app.example.com"], credentials: true, maxAge: 600 }))
  .use(mount(api));

const handler = toFetchHandler(app);

Bun.serve({
  fetch(request, server) {
    // rateLimit identifies clients by `request.ip`; Bun does not set it, so you do.
    Object.assign(request, { ip: server.requestIP(request)?.address });
    return handler(request, server);
  },
});
```

Where each piece goes, and why:

- **App level, before `mount(api)`: `secureHeaders()`, then `cors()`.** `secureHeaders` calls `next()` first
  and sets its headers on the way back out, so it covers every response, including ones other middleware
  produced. `cors` must be on the app, not the router: a middleware added with `router.use()` only runs when
  one of the router's later routes matches the request's method and path, so a preflight `OPTIONS` request for
  a path that only has a `GET` route would skip it. App-level middleware needs the HTTP input declared, hence
  `new Rhythm<{}, RhythmHttpContext>()`; a plain `new Rhythm()` accepts only `mount(...)` for HTTP routers.
- **Router level, in this order: `csrf` -> `rateLimit` -> your own guards.** Cheap rejections first, then
  anything that costs more, such as identity checks you write or take from another package.
- **`Bun.serve`.** `toFetchHandler(app)` returns `(request, server) => Promise<Response>`; pass Bun's `server`
  through so `ctx.server` is available. `rateLimit` does not read `ctx.server`: it only sees the `Request` and
  reads `request.ip` (see [rate limiting](#rhythmjssecurityrate-limit)). Because nothing in Rhythm sets that
  property, either assign it as above, set `trustProxy` (behind a proxy), or pass your own `keyOf`. Otherwise
  the first limited request throws.

What ends up on `ctx`:

- Response headers set by the middleware on `ctx.response`: `Access-Control-*`, `RateLimit-*`, `Retry-After`,
  and the secure headers. Nothing is added to the context itself.

## `@rhythmjs/security/cors`

`cors(options?)`: Cross-Origin Resource Sharing, modeled on Hono's cors middleware. Sets `Access-Control-*`
headers and answers preflight `OPTIONS` requests with `204` without calling `next()`, so the router never
runs for them. Add it to the app, before `mount(router)`.

`CorsOptions`:

- `origin`: `"*"` (default), a single origin, an array of origins, or `(origin) => string | null`. For anything
  other than `"*"` the origin is echoed back only on a match and `Vary: Origin` is appended.
- `allowMethods`: default `GET, HEAD, PUT, POST, DELETE, PATCH, QUERY`.
- `allowHeaders`: default reflects the preflight's `Access-Control-Request-Headers`.
- `exposeHeaders`, `maxAge` (seconds, preflight only), `credentials`.

Gotcha: `credentials: true` with the default `origin: "*"` is not valid for browsers; list explicit origins.

## `@rhythmjs/security/csrf`

`csrf(options?)`: CSRF protection by origin checking, following Hono. A request is rejected with `403` only
when it is not `GET`/`HEAD`, its `Content-Type` is a form type (`application/x-www-form-urlencoded`,
`multipart/form-data`, `text/plain`), and its `Origin` header is missing or not allowed. Everything else,
including JSON requests (cross-site pages cannot send those without a CORS preflight), passes.

- `csrf()`: allows only the request URL's own origin.
- `csrf({ origin })`: a string, an array of strings, or `(origin) => boolean`.
- A blocked request gets `403 { "success": false, "status": 403, "message": "Forbidden" }`.

Behind a TLS-terminating proxy the request URL's origin may be `http://...` while browsers send an `https://`
`Origin`; set `origin` explicitly in that case.

## `@rhythmjs/security/rate-limit`

Fixed-window rate limiting with pluggable storage.

```ts
import { rateLimit } from "@rhythmjs/security/rate-limit";

new RhythmRouter().use(rateLimit({ limit: 100, windowMs: 60_000, trustProxy: 1 }));
```

`RateLimitOptions`:

- `limit` (default `100`) requests per `windowMs` (default `60_000`).
- `store`: a `RateLimitStore` (`increment(key, windowMs)` returning `{ count, resetAt }`, and `reset(key)`;
  sync or async). Defaults to a per-middleware `memoryRateLimitStore()`. Share one instance across
  middleware, or back a store with Redis, to share a budget across pipelines or processes.
  `memoryRateLimitStore({ maxKeys })` (default `10_000`) evicts the oldest-inserted key when full, so a key
  flood cannot grow memory without bound, at the cost of possibly resetting other clients' counters.
- `keyOf(request)`: the bucket key, sync or async. Default is the client IP, resolved in this order:
  1. with `trustProxy`, the valid IPv4/IPv6 entry of `X-Forwarded-For` that many hops from the right (the one
     your own proxy appended; a client cannot open new buckets by prepending addresses);
  2. otherwise `request.ip`, when set to a non-empty string;
  3. otherwise it throws `rateLimit: cannot identify the client...` rather than silently sharing one bucket
     among all clients. Use `keyOf: () => "global"` if a site-wide limit is what you want.
- `trustProxy`: `false` (default), `true` (one hop), or a hop count. With `false`, `X-Forwarded-For` is
  ignored entirely, since anyone can send it. Behind a proxy you must set `trustProxy` (or `keyOf`),
  otherwise every client shares the proxy's address.
- `skip(request)`: exempt requests (health checks, internal traffic).
- `headers`: set `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds) on every response
  (default `true`). `Retry-After` is always set on a rejection.
- `message`: the rejection message.
- A blocked request gets `429 { "success": false, "status": 429, "message": "Too Many Requests" }`.

`rateLimitWs(options?)` takes the same options and returns a `(ctx, next)` middleware over a minimal
`RateLimitWsContext` (`{ request, response }`); a rejection sets `ctx.response` to a `Response` with the
same `429` body. It has no dependency on `@rhythmjs/ws`.

Also exported: `memoryRateLimitStore`, and the types `RateLimitStore`, `RateLimitInfo`,
`MemoryRateLimitStoreOptions`, `RateLimitWsContext`, `RateLimitWsMiddleware`.

## `@rhythmjs/security/secure-headers`

`secureHeaders(options?)`: Helmet-style headers, set on `ctx.response` after the downstream middleware and
handlers have run (it calls `next()` first), so it overwrites any same-named header they set.

| Header                              | Default                               |
| ----------------------------------- | ------------------------------------- |
| `Cross-Origin-Opener-Policy`        | `same-origin`                         |
| `Cross-Origin-Resource-Policy`      | `same-origin`                         |
| `Referrer-Policy`                   | `no-referrer`                         |
| `Strict-Transport-Security`         | `max-age=15552000; includeSubDomains` |
| `X-Content-Type-Options`            | `nosniff`                             |
| `X-DNS-Prefetch-Control`            | `off`                                 |
| `X-Download-Options`                | `noopen`                              |
| `X-Frame-Options`                   | `SAMEORIGIN`                          |
| `X-Permitted-Cross-Domain-Policies` | `none`                                |
| `X-XSS-Protection`                  | `0`                                   |

Every option (`contentSecurityPolicy`, `crossOriginEmbedderPolicy`, `crossOriginOpenerPolicy`,
`crossOriginResourcePolicy`, `referrerPolicy`, `strictTransportSecurity`, `xContentTypeOptions`,
`xDnsPrefetchControl`, `xDownloadOptions`, `xFrameOptions`, `xPermittedCrossDomainPolicies`,
`xXssProtection`) takes a string to override the value or `false` to drop the header.
`contentSecurityPolicy` and `crossOriginEmbedderPolicy` have no default and are set only when configured.

```ts
secureHeaders({
  contentSecurityPolicy: "default-src 'self'",
  crossOriginEmbedderPolicy: "require-corp",
  xFrameOptions: "DENY",
  strictTransportSecurity: false,
});
```

## Testing

With [`@rhythmjs/testing`](https://github.com/rhythmjs/testing), drive the app in memory. `request.ip` is
not set by the test client, so give `rateLimit` a `keyOf` in tests, or send a `Request` you have assigned
`ip` to via `client.fetch`.

```ts
import { createTestClient } from "@rhythmjs/testing/router";

const client = createTestClient(app);

const res = await client.get("/hello");
expect(res.status).toBe(200);
expect(res.headers.get("x-content-type-options")).toBe("nosniff");
```
