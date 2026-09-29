import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/adapters/bun";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import {
  attachUser,
  getBasicCredentials,
  getBearerToken,
  isAuthenticated,
  redirectIfAuthenticated,
  requireAuthentication,
} from "./authentication";

type User = { id: string; name: string };
const ada: User = { id: "1", name: "Ada" };

const serve = (router: RhythmRouter<any>) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

describe("attachUser()", () => {
  test("resolves and attaches the user for downstream middleware", async () => {
    const router = new RhythmRouter()
      .use(attachUser(async (ctx) => (getBearerToken(ctx.request) === "t1" ? ada : null)))
      .get("/me", (ctx) => ctx.json({ user: ctx.user }));
    const handler = serve(router);

    const authed = await handler(new Request("http://localhost/me", { headers: { authorization: "Bearer t1" } }));
    expect(await authed.json()).toEqual({ user: ada });

    const anonymous = await handler(new Request("http://localhost/me"));
    expect(await anonymous.json()).toEqual({ user: null });
  });

  test("normalizes an undefined resolution to null", async () => {
    const router = new RhythmRouter()
      .use(attachUser(() => undefined))
      .get("/me", (ctx) => ctx.json({ user: ctx.user }));

    const res = await serve(router)(new Request("http://localhost/me"));

    expect(await res.json()).toEqual({ user: null });
  });

  test("rejects a non-function resolver", () => {
    expect(() => attachUser(null as never)).toThrow(TypeError);
  });
});

describe("requireAuthentication()", () => {
  test("lets an authenticated request through with a narrowed user", async () => {
    const router = new RhythmRouter()
      .use(attachUser(() => ada))
      .get("/me", requireAuthentication<User>(), (ctx) => ctx.json({ name: ctx.user.name }));

    const res = await serve(router)(new Request("http://localhost/me"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Ada" });
  });

  test("responds 401 by default when there is no user", async () => {
    const events: string[] = [];
    const router = new RhythmRouter().use(attachUser(() => null)).get("/me", requireAuthentication(), (ctx) => {
      events.push("handler");
      ctx.json({});
    });

    const res = await serve(router)(new Request("http://localhost/me"));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
    expect(events).toEqual([]);
  });

  test("honors status, message, and challenge options", async () => {
    const router = new RhythmRouter()
      .use(attachUser(() => null))
      .get("/me", requireAuthentication({ status: 403, message: "nope", challenge: 'Bearer realm="api"' }), (ctx) =>
        ctx.json({}),
      );

    const res = await serve(router)(new Request("http://localhost/me"));

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("nope");
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="api"');
  });

  test("redirects instead when redirectTo is set", async () => {
    const router = new RhythmRouter()
      .use(attachUser(() => null))
      .get("/dashboard", requireAuthentication({ redirectTo: "/login" }), (ctx) => ctx.json({}));

    const res = await serve(router)(new Request("http://localhost/dashboard", { redirect: "manual" }));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("redirectIfAuthenticated()", () => {
  test("redirects a logged-in user away and lets anonymous users through", async () => {
    const make = (user: User | null) =>
      new RhythmRouter()
        .use(attachUser(() => user))
        .get("/login", redirectIfAuthenticated("/dashboard"), (ctx) => ctx.text("login page"));

    const authed = await serve(make(ada))(new Request("http://localhost/login", { redirect: "manual" }));
    expect(authed.status).toBe(302);
    expect(authed.headers.get("location")).toBe("/dashboard");

    const anonymous = await serve(make(null))(new Request("http://localhost/login"));
    expect(await anonymous.text()).toBe("login page");
  });
});

describe("isAuthenticated()", () => {
  test("narrows on user presence", () => {
    expect(isAuthenticated({ user: ada })).toBe(true);
    expect(isAuthenticated({ user: null })).toBe(false);
  });
});

describe("getBearerToken()", () => {
  test("extracts the token with a case-insensitive scheme", () => {
    expect(getBearerToken(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(getBearerToken(new Request("http://x", { headers: { authorization: "bearer abc" } }))).toBe("abc");
  });

  test("returns null for missing, non-bearer, or empty credentials", () => {
    expect(getBearerToken(new Request("http://x"))).toBeNull();
    expect(getBearerToken(new Request("http://x", { headers: { authorization: "Basic abc" } }))).toBeNull();
    expect(getBearerToken(new Request("http://x", { headers: { authorization: "Bearer   " } }))).toBeNull();
  });
});

describe("getBasicCredentials()", () => {
  const encode = (raw: string) => `Basic ${btoa(raw)}`;

  test("decodes username and password", () => {
    const request = new Request("http://x", { headers: { authorization: encode("ada:pw") } });
    expect(getBasicCredentials(request)).toEqual({ username: "ada", password: "pw" });
  });

  test("splits on the first colon only", () => {
    const request = new Request("http://x", { headers: { authorization: encode("ada:p:w:1") } });
    expect(getBasicCredentials(request)).toEqual({ username: "ada", password: "p:w:1" });
  });

  test("returns null for missing, malformed, or colon-less credentials", () => {
    expect(getBasicCredentials(new Request("http://x"))).toBeNull();
    expect(getBasicCredentials(new Request("http://x", { headers: { authorization: "Basic !!!" } }))).toBeNull();
    expect(getBasicCredentials(new Request("http://x", { headers: { authorization: encode("nocolon") } }))).toBeNull();
    expect(getBasicCredentials(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBeNull();
  });
});
