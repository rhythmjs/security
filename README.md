# @rhythmjs/security

Security middleware for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend
framework: authentication plumbing, authorization guards, CORS, CSRF protection, rate limiting, and
secure headers. Each module is exported by its own subpath; there is no root barrel export.

## Install

```sh
bun add @rhythmjs/security @rhythmjs/rhythm @rhythmjs/router
```

Routers are mounted into a `Rhythm` app with `mount(router)`; the snippets below that show only a router assume that.

## `@rhythmjs/security/authentication`

Strategy-agnostic authentication plumbing: it does not verify credentials itself; you decide how a
request maps to a user (session lookup, token check, anything) and these helpers handle the rest around
the `ctx.user` convention.

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { attachUser, getBearerToken, requireAuthentication } from "@rhythmjs/security/authentication";

const me = new RhythmRouter()
  .use(attachUser(async (ctx) => users.findByToken(getBearerToken(ctx.request))))
  .get("/me", requireAuthentication<User>(), (ctx) => {
    ctx.json(ctx.user);
  });

const app = new Rhythm().use(mount(me));
```

- `attachUser(resolve)`: extension middleware (built on `derive`) that runs your resolver on every request and attaches
  `ctx.user` (`TUser | null`). This is the single integration point for whatever auth strategy you use.
- `requireAuthentication(options?)`: extension middleware that gates a route; with a user it narrows
  `ctx.user` to `TUser` for the handler; without one it responds `401` (or `options.status` /
  `options.message`), sets `WWW-Authenticate` from `options.challenge`, or redirects to
  `options.redirectTo` for web pages.
- `redirectIfAuthenticated(to)`: for login/signup pages; sends logged-in users away.
- `isAuthenticated(ctx)`: type-guard convenience over `ctx.user`.
- `getBearerToken(request)` / `getBasicCredentials(request)`: correct, case-insensitive
  `Authorization` header parsing (`Bearer` token, or decoded `{ username, password }` split on the first
  colon).

## `@rhythmjs/security/authorization`

Guards that run after authentication, against whatever user shape `attachUser` produced. All of them
respond `401` when there is no user and `403` when the user is missing what the route requires.

```ts
import { authorize, requirePermissions, requireRoles } from "@rhythmjs/security/authorization";

router
  .get("/admin", requireRoles(["admin"]), handler)
  .get("/posts", requirePermissions(["posts:read", "posts:write"]), handler)
  .delete(
    "/posts/:id",
    authorize(async (ctx) => (await posts.find(ctx.params.id)).ownerId === ctx.user.id),
    handler,
  );
```

- `authorize(check, options?)`: the generic guard, a sync or async predicate over the context;
  `false` responds `403` (or `options.status` / `options.message`).
- `requireRoles(roles, options?)`: reads `user.roles` by default (override with `options.roles`);
  `options.match` is `"any"` by default.
- `requirePermissions(permissions, options?)`: same over `user.permissions`; `options.match` defaults
  to `"all"`.

## `@rhythmjs/security/cors`

Cross-Origin Resource Sharing, modeled on
[Hono's cors middleware](https://github.com/honojs/hono/blob/main/src/middleware/cors/index.ts): sets the
`Access-Control-*` headers on every response and answers preflight `OPTIONS` requests with `204` before the
router runs.

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import { cors } from "@rhythmjs/security/cors";

const router = new RhythmRouter().get("/api/data", (ctx) => {
  ctx.text("data");
});

const app = new Rhythm<{}, RhythmHttpContext>()
  .use(cors({ origin: ["https://app.example.com"], credentials: true, maxAge: 600 }))
  .use(mount(router));
```

Add `cors()` to the app with `.use()`, before `mount(router)`. A middleware added with `router.use()` only runs when one of the router's later routes matches the request's method and path, so a preflight `OPTIONS` request for a path that only has a `GET` route would skip it.

Options (`CorsOptions`):

- `origin`: `"*"` (default), a single origin string, an array of origins, or
  `(origin) => string | null`. Non-wildcard origins are echoed back only when they match, and
  `Vary: Origin` is appended.
- `allowMethods`: default `GET,HEAD,PUT,POST,DELETE,PATCH,QUERY`.
- `allowHeaders`: default is to reflect the preflight's `Access-Control-Request-Headers`.
- `exposeHeaders`, `maxAge`, `credentials`.

## `@rhythmjs/security/csrf`

CSRF protection by origin checking, following Hono's approach: cross-site form submissions
(`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) with a missing or unallowed
`Origin` header are rejected with `403`. Safe methods (`GET`, `HEAD`) and non-form content types (which
cross-site pages cannot send without a CORS preflight) pass through.

```ts
import { csrf } from "@rhythmjs/security/csrf";

new RhythmRouter().use(csrf()).post("/submit", (ctx) => {
  ctx.text("submitted");
});
```

- `csrf()`: allows only same-origin form posts (the request URL's own origin).
- `csrf({ origin })`: a string, array of strings, or `(origin) => boolean` naming the allowed origins.
- A blocked request gets `403 { "success": false, "status": 403, "message": "Forbidden" }`.

## `@rhythmjs/security/rate-limit`

Fixed-window rate limiting with pluggable storage. Two entry points share the same options and stores:
`rateLimit` for the HTTP pipeline and `rateLimitWs` for WebSocket upgrades, shaped exactly like an
`@rhythmjs/ws` middleware (`(ctx, next)`; it sets `ctx.response` to reject), with no dependency on
it.

```ts
import { rateLimit } from "@rhythmjs/security/rate-limit";

new RhythmRouter().use(rateLimit({ limit: 100, windowMs: 60_000 })).get("/api/data", (ctx) => {
  ctx.text("data");
});
```

```ts
import { rateLimitWs } from "@rhythmjs/security/rate-limit";
import { RhythmWs } from "@rhythmjs/ws";

new RhythmWs().use(rateLimitWs({ limit: 10 })).route("/chat", { message(peer, message) {} });
```

Options (`RateLimitOptions`, shared by both):

- `limit`: requests allowed per window (default `100`).
- `windowMs`: window length in milliseconds (default `60_000`).
- `store`: any object satisfying `RateLimitStore` (`increment(key, windowMs)` returning
  `{ count, resetAt }`, and `reset(key)`; sync or async). Defaults to `memoryRateLimitStore()`, a
  per-middleware in-memory store; pass one instance to both middleware (or back it with Redis etc.) to
  share a budget across pipelines and processes. The memory store holds at most `maxKeys` (default
  `10_000`) keys, evicting the oldest-inserted one when full, so key-rotation floods cannot grow memory
  without bound (at the cost that a flood can reset other clients' counters; use a Redis store if that
  matters).
- `trustProxy`: how many reverse-proxy hops in front of the server to trust (default `false`, `true`
  means `1`). When set, the default key is the `x-forwarded-for` entry that many hops from the
  _right_ — the entry your own proxy appended — so a client cannot open fresh buckets by prepending
  spoofed addresses. The entry must be a valid IPv4/IPv6 address (no port); otherwise it is ignored and
  the key falls back to `request.ip`. Leave it off for direct deployments: then `x-forwarded-for` is ignored
  entirely, since anyone can send it.
- `keyOf(request)`: the bucket key. Defaults to the client IP: the trusted `x-forwarded-for` entry
  when `trustProxy` is set, else `request.ip` when present (expose it in your `Bun.serve` fetch via
  `server.requestIP()`; see the router README), else the request throws instead of silently sharing
  one bucket across all clients (use `keyOf: () => "global"` if a site-wide limit is what you want).
  Behind a proxy you must set `trustProxy` (or a custom `keyOf`): otherwise every client shares the
  proxy's `request.ip` bucket and one abuser can exhaust the site-wide budget.
- `skip(request)`: exempt requests (health checks, internal traffic).
- `headers`: set `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` (seconds) on responses
  (default `true`). `Retry-After` is always set on rejections.
- `message`: body message for rejections.
- A blocked request gets `429 { "success": false, "status": 429, "message": "Too Many Requests" }`;
  `rateLimitWs` rejects the upgrade with the same response.

## `@rhythmjs/security/secure-headers`

Helmet-style security headers, applied to every response after the handlers run.

```ts
import { secureHeaders } from "@rhythmjs/security/secure-headers";

new RhythmRouter().use(secureHeaders()).get("/", (ctx) => {
  ctx.html("<h1>hi</h1>");
});
```

Defaults:

| Header                              | Value                                 |
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

Every option accepts a string to override the value or `false` to drop the header.
`contentSecurityPolicy` and `crossOriginEmbedderPolicy` are off by default and set only when configured:

```ts
secureHeaders({
  contentSecurityPolicy: "default-src 'self'",
  crossOriginEmbedderPolicy: "require-corp",
  xFrameOptions: "DENY",
  strictTransportSecurity: false,
});
```

## Development

```sh
bun install
bun test # bun test runner
bun run typecheck # tsc --noEmit
bun run build # bun build + tsc declarations
```
