# @rhythmjs/security

Security middleware for [Rhythm](https://github.com/rhythmjs/rhythm) routers and handlers. Each module is
exported by its own subpath — there is no root barrel export.

## Install

```sh
pnpm add @rhythmjs/security @rhythmjs/rhythm @rhythmjs/router
```

## `@rhythmjs/security/authentication`

Strategy-agnostic authentication plumbing: it does not verify credentials itself — you decide how a
request maps to a user (session lookup, token check, anything) and these helpers handle the rest around
the `ctx.user` convention.

```ts
import { attachUser, getBearerToken, requireAuthentication } from "@rhythmjs/security/authentication";

new RhythmRouter()
  .use(attachUser(async (ctx) => users.findByToken(getBearerToken(ctx.request))))
  .get("/me", requireAuthentication<User>(), (ctx) => {
    ctx.json(ctx.user);
  });
```

- `attachUser(resolve)` — derive middleware: runs your resolver on every request and attaches
  `ctx.user` (`TUser | null`). This is the single integration point for whatever auth strategy you use.
- `requireAuthentication(options?)` — derive middleware that gates a route: with a user it narrows
  `ctx.user` to `TUser` for the handler; without one it responds `401` (or `options.status` /
  `options.message`), sets `WWW-Authenticate` from `options.challenge`, or redirects to
  `options.redirectTo` for web pages.
- `redirectIfAuthenticated(to)` — for login/signup pages: sends logged-in users away.
- `isAuthenticated(ctx)` — type-guard convenience over `ctx.user`.
- `getBearerToken(request)` / `getBasicCredentials(request)` — correct, case-insensitive
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

- `authorize(check, options?)` — the generic guard: a sync or async predicate over the context;
  `false` responds `403` (or `options.status` / `options.message`).
- `requireRoles(roles, options?)` — reads `user.roles` by default (override with `options.roles`);
  `options.match` is `"any"` by default.
- `requirePermissions(permissions, options?)` — same over `user.permissions`; `options.match` defaults
  to `"all"`.

## `@rhythmjs/security/cors`

Cross-Origin Resource Sharing, modeled on
[Hono's cors middleware](https://github.com/honojs/hono/blob/main/src/middleware/cors/index.ts): sets the
`Access-Control-*` headers on every response and answers preflight `OPTIONS` requests with `204` before the
router runs.

```ts
import { RhythmRouter } from "@rhythmjs/router";
import { cors } from "@rhythmjs/security/cors";

new RhythmRouter()
  .use(cors({ origin: ["https://app.example.com"], credentials: true, maxAge: 600 }))
  .get("/api/data", (ctx) => {
    ctx.response.body = "data";
  });
```

Options (`CorsOptions`):

- `origin` — `"*"` (default), a single origin string, an array of origins, or
  `(origin) => string | null`. Non-wildcard origins are echoed back only when they match, and
  `Vary: Origin` is appended.
- `allowMethods` — default `GET,HEAD,PUT,POST,DELETE,PATCH,QUERY`.
- `allowHeaders` — default: reflect the preflight's `Access-Control-Request-Headers`.
- `exposeHeaders`, `maxAge`, `credentials`.

## `@rhythmjs/security/csrf`

CSRF protection by origin checking, following Hono's approach: cross-site form submissions
(`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) with a missing or unallowed
`Origin` header are rejected with `403`. Safe methods (`GET`, `HEAD`) and non-form content types (which
cross-site pages cannot send without a CORS preflight) pass through.

```ts
import { csrf } from "@rhythmjs/security/csrf";

new RhythmRouter().use(csrf()).post("/submit", (ctx) => {
  ctx.response.body = "submitted";
});
```

- `csrf()` — allows only same-origin form posts (the request URL's own origin).
- `csrf({ origin })` — a string, array of strings, or `(origin) => boolean` naming the allowed origins.
- A blocked request gets `403 { "success": false, "status": 403, "message": "Forbidden" }`.

## `@rhythmjs/security/secure-headers`

Helmet-style security headers, applied to every response after the handlers run.

```ts
import { secureHeaders } from "@rhythmjs/security/secure-headers";

new RhythmRouter().use(secureHeaders()).get("/", (ctx) => {
  ctx.response.body = "<h1>hi</h1>";
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
pnpm install
pnpm test       # vp test
pnpm typecheck  # tsc --noEmit
pnpm build      # vp pack
```
