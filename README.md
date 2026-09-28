# @rhythmjs/security

Security middleware for [Rhythm](https://github.com/rhythmjs/rhythm) routers and handlers. Each module is
exported by its own subpath — there is no root barrel export.

## Install

```sh
pnpm add @rhythmjs/security @rhythmjs/rhythm @rhythmjs/router
```

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
