import { describe, expect, test } from "bun:test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { csrf, type CsrfOptions } from "./csrf";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const app = (options?: CsrfOptions) =>
  serve(
    new RhythmRouter()
      .use(csrf(options))
      .get("/form", (ctx) => {
        ctx.text("page");
      })
      .post("/submit", (ctx) => {
        ctx.text("submitted");
      }),
  );

const formPost = (headers: Record<string, string>) =>
  new Request("http://localhost/submit", { method: "POST", body: "a=1", headers });

describe("csrf", () => {
  test("lets safe methods through without an origin header", async () => {
    const res = await app()(new Request("http://localhost/form"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page");
  });

  test("blocks a form post without an origin header", async () => {
    const res = await app()(formPost({ "content-type": "application/x-www-form-urlencoded" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, status: 403, message: "Forbidden" });
  });

  test("allows a same-origin form post by default", async () => {
    const res = await app()(
      formPost({ "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("submitted");
  });

  test("blocks a cross-origin form post by default", async () => {
    const res = await app()(
      formPost({ "content-type": "application/x-www-form-urlencoded", origin: "http://evil.test" }),
    );

    expect(res.status).toBe(403);
  });

  test("guards multipart and text/plain form submissions too", async () => {
    const multipart = await app()(formPost({ "content-type": "multipart/form-data; boundary=x" }));
    expect(multipart.status).toBe(403);

    const plain = await app()(formPost({ "content-type": "text/plain" }));
    expect(plain.status).toBe(403);
  });

  test("does not block non-form content types", async () => {
    const res = await app()(formPost({ "content-type": "application/json" }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("submitted");
  });

  test("accepts origins from a configured string, array, or function", async () => {
    const fromString = await app({ origin: "http://trusted.test" })(
      formPost({ "content-type": "text/plain", origin: "http://trusted.test" }),
    );
    expect(fromString.status).toBe(200);

    const fromArray = await app({ origin: ["http://a.test", "http://b.test"] })(
      formPost({ "content-type": "text/plain", origin: "http://b.test" }),
    );
    expect(fromArray.status).toBe(200);

    const fromFunction = await app({ origin: (origin) => origin.endsWith(".trusted.test") })(
      formPost({ "content-type": "text/plain", origin: "http://app.trusted.test" }),
    );
    expect(fromFunction.status).toBe(200);

    const rejected = await app({ origin: "http://trusted.test" })(
      formPost({ "content-type": "text/plain", origin: "http://evil.test" }),
    );
    expect(rejected.status).toBe(403);
  });
});
