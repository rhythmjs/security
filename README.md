# @rhythmjs/security

Security middleware for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework:
authentication plumbing, authorization guards, CORS, CSRF protection, rate limiting, and secure headers.

Everything here is ordinary Rhythm middleware over the HTTP context from `@rhythmjs/router`. Edge concerns
(`secureHeaders`, `cors`) go on the `Rhythm` app, in front of the mounted router; request-gating concerns
(`csrf`, `rateLimit`, `attachUser`, `requireAuthentication`, `requireRoles`, ...) go on a router or on
individual routes. Each module has its own subpath export; there is no root export.

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
import { attachUser, getBearerToken, requireAuthentication } from "@rhythmjs/security/authentication";
import { requireRoles } from "@rhythmjs/security/authorization";
import { cors } from "@rhythmjs/security/cors";
import { csrf } from "@rhythmjs/security/csrf";
import { rateLimit } from "@rhythmjs/security/rate-limit";
import { secureHeaders } from "@rhythmjs/security/secure-headers";

type User = { id: string; roles: string[] };

const api = new RhythmRouter()
  .use(csrf())
  .use(rateLimit({ limit: 100, windowMs: 60_000 }))
  .use(attachUser((ctx) => users.findByToken(getBearerToken(ctx.request))))
  .get("/me", requireAuthentication<User>(), (ctx) => {
    ctx.json(ctx.user);
  })
  .get("/admin", requireAuthentication<User>(), requireRoles(["admin"]), (ctx) => {
    ctx.json({ admin: ctx.user.id });
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
- **Router level, in this order: `csrf` -> `rateLimit` -> `attachUser` -> per-route guards.** Cheap rejections
  first, then identity, then `requireAuthentication` and `requireRoles` / `requirePermissions` / `authorize` as
  route-level handlers before the final handler.
- **`Bun.serve`.** `toFetchHandler(app)` returns `(request, server) => Promise<Response>`; pass Bun's `server`
  through so `ctx.server` is available. `rateLimit` does not read `ctx.server`: it only sees the `Request` and
  reads `request.ip` (see [rate limiting](#rhythmjssecurityrate-limit)). Because nothing in Rhythm sets that
  property, either assign it as above, set `trustProxy` (behind a proxy), or pass your own `keyOf`. Otherwise
  the first limited request throws.

What ends up on `ctx`:

- `ctx.user` (`TUser | null`) after `attachUser`; narrowed to `TUser` after `requireAuthentication<TUser>()`.
- Response headers set by the middleware on `ctx.response`: `Access-Control-*`, `RateLimit-*`, `Retry-After`,
  and the secure headers. Nothing else is added to the context.

## `@rhythmjs/security/authentication`

Strategy-agnostic: it never verifies credentials. You decide how a request maps to a user (session lookup,
token check, anything); these helpers handle the `ctx.user` convention around it.

- `attachUser(resolve)`: a `derive` middleware that runs `resolve(ctx)` (sync or async) on every request
  and sets `ctx.user` to the result, `null` when the resolver returns `null` or `undefined`. Throws a
  `TypeError` at creation if `resolve` is not a function.
- `requireAuthentication<TUser>(options?)`: route guard that narrows `ctx.user` to `TUser`. With no user it
  responds `401` (or `options.status` / `options.message`), setting `WWW-Authenticate` from
  `options.challenge`; with `options.redirectTo` it redirects instead.
- `redirectIfAuthenticated(to)`: for login/signup pages; redirects logged-in users to `to`.
- `isAuthenticated(ctx)`: type guard, true when `ctx.user` is neither `null` nor `undefined`.
- `getBearerToken(request)`: the token from `Authorization: Bearer ...` (case-insensitive scheme), or `null`.
- `getBasicCredentials(request)`: `{ username, password }` decoded from `Authorization: Basic ...`, split on
  the first colon, or `null` when missing or malformed.

Types: `UserContext`, `BasicCredentials`, `RequireAuthenticationOptions`.

## `@rhythmjs/security/authorization`

Guards for use after `attachUser`. Role and permission guards respond `401` when there is no user and `403`
when the user lacks what the route requires.

```ts
import { authorize, requirePermissions, requireRoles } from "@rhythmjs/security/authorization";

router
  .get("/admin", requireRoles(["admin"]), handler)
  .get("/posts", requirePermissions(["posts:read", "posts:write"]), handler)
  .delete("/posts/:id", authorize(async (ctx) => (await posts.find(ctx.params.id)).ownerId === ctx.user.id), handler);
```

- `authorize(check, options?)`: generic guard over a sync or async predicate on the context; `false` responds
  `403` (or `options.status` / `options.message`). It does not check for a user itself, so put
  `requireAuthentication()` before any `check` that reads `ctx.user`.
- `requireRoles(roles, options?)`: reads `user.roles` (override with `options.roles: (user) => string[]`);
  `options.match` is `"any"` by default.
- `requirePermissions(permissions, options?)`: same over `user.permissions` (override with
  `options.permissions`); `options.match` is `"all"` by default.
- The `401` for a missing user ignores `options.status` / `options.message`; those apply to the `403`.

Types: `AuthorizeOptions`, `RequireRolesOptions`, `RequirePermissionsOptions`.

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

const res = await client.get("/me", { headers: { authorization: "Bearer t1" } });
expect(res.status).toBe(200);
expect((await client.get("/me")).status).toBe(401);
```
