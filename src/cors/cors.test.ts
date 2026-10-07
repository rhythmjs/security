import { describe, expect, test } from "bun:test";
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import { cors, type CorsOptions } from "./cors";

const app = (options?: CorsOptions) => {
  const events: string[] = [];
  const router = new RhythmRouter().get("/api/data", (ctx) => {
    ctx.text("data");
  });
  const handler = toFetchHandler(
    new Rhythm<{}, RhythmHttpContext>()
      .use(cors(options))
      .use(async (ctx, next) => {
        events.push("downstream");
        await next();
      })
      .use(mount(router)),
  );
  return { handler, events };
};

describe("cors", () => {
  test("defaults to a wildcard allow-origin on simple requests", async () => {
    const { handler } = app();
    const res = await handler(new Request("http://localhost/api/data", { headers: { origin: "http://evil.test" } }));

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBeNull();
    expect(await res.text()).toBe("data");
  });

  test("answers preflight with 204, allow-methods, and no body, without running downstream", async () => {
    const { handler, events } = app();
    const res = await handler(new Request("http://localhost/api/data", { method: "OPTIONS" }));

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,HEAD,PUT,POST,DELETE,PATCH,QUERY");
    expect(await res.text()).toBe("");
    expect(events).toEqual([]);
  });

  test("a single-origin string is echoed only for that origin and adds Vary: Origin", async () => {
    const { handler } = app({ origin: "http://allowed.test" });

    const allowed = await handler(
      new Request("http://localhost/api/data", { headers: { origin: "http://allowed.test" } }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const blocked = await handler(
      new Request("http://localhost/api/data", { headers: { origin: "http://evil.test" } }),
    );
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an origin array echoes only listed origins", async () => {
    const { handler } = app({ origin: ["http://a.test", "http://b.test"] });

    const a = await handler(new Request("http://localhost/api/data", { headers: { origin: "http://b.test" } }));
    expect(a.headers.get("access-control-allow-origin")).toBe("http://b.test");

    const other = await handler(new Request("http://localhost/api/data", { headers: { origin: "http://c.test" } }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an origin function decides the allowed origin", async () => {
    const { handler } = app({ origin: (origin) => (origin.endsWith(".trusted.test") ? origin : null) });

    const res = await handler(
      new Request("http://localhost/api/data", { headers: { origin: "http://app.trusted.test" } }),
    );

    expect(res.headers.get("access-control-allow-origin")).toBe("http://app.trusted.test");
  });

  test("sets credentials, expose-headers, and max-age when configured", async () => {
    const { handler } = app({
      origin: "http://allowed.test",
      credentials: true,
      exposeHeaders: ["x-total-count", "etag"],
      maxAge: 600,
    });

    const res = await handler(
      new Request("http://localhost/api/data", {
        method: "OPTIONS",
        headers: { origin: "http://allowed.test" },
      }),
    );

    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-expose-headers")).toBe("x-total-count,etag");
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  test("preflight reflects access-control-request-headers when allowHeaders is not configured", async () => {
    const { handler } = app();
    const res = await handler(
      new Request("http://localhost/api/data", {
        method: "OPTIONS",
        headers: { "access-control-request-headers": "content-type, x-api-key" },
      }),
    );

    expect(res.headers.get("access-control-allow-headers")).toBe("content-type,x-api-key");
    expect(res.headers.get("vary")).toBe("Access-Control-Request-Headers");
  });

  test("preflight uses configured allowHeaders over the requested ones", async () => {
    const { handler } = app({ allowHeaders: ["content-type"] });
    const res = await handler(
      new Request("http://localhost/api/data", {
        method: "OPTIONS",
        headers: { "access-control-request-headers": "x-api-key" },
      }),
    );

    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
  });
});
