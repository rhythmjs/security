import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/adapters/bun";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { secureHeaders, type SecureHeadersOptions } from "./secure-headers";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.routes()));

const app = (options?: SecureHeadersOptions) =>
  serve(
    new RhythmRouter().use(secureHeaders(options)).get("/", (ctx) => {
      ctx.response.headers.set("content-type", "text/html");
      ctx.response.body = "<h1>hi</h1>";
    }),
  );

describe("secureHeaders", () => {
  test("sets the default security headers", async () => {
    const res = await app()(new Request("http://localhost/"));

    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=15552000; includeSubDomains");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
    expect(res.headers.get("x-download-options")).toBe("noopen");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("x-permitted-cross-domain-policies")).toBe("none");
    expect(res.headers.get("x-xss-protection")).toBe("0");
  });

  test("does not set content-security-policy or embedder policy unless configured", async () => {
    const res = await app()(new Request("http://localhost/"));

    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("cross-origin-embedder-policy")).toBeNull();
  });

  test("a string option overrides the default value", async () => {
    const res = await app({ xFrameOptions: "DENY", referrerPolicy: "strict-origin-when-cross-origin" })(
      new Request("http://localhost/"),
    );

    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  test("false disables a default header", async () => {
    const res = await app({ strictTransportSecurity: false, xXssProtection: false })(new Request("http://localhost/"));

    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("x-xss-protection")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("sets content-security-policy and embedder policy when configured", async () => {
    const res = await app({
      contentSecurityPolicy: "default-src 'self'",
      crossOriginEmbedderPolicy: "require-corp",
    })(new Request("http://localhost/"));

    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  test("leaves handler-set headers and the body untouched", async () => {
    const res = await app()(new Request("http://localhost/"));

    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<h1>hi</h1>");
  });
});
