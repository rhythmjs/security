import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmRouterContext } from "@rhythmjs/router";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { attachUser } from "../authentication/authentication";
import { authorize, requirePermissions, requireRoles } from "./authorization";

type User = { id: string; roles: string[]; permissions: string[] };
const editor: User = { id: "1", roles: ["editor"], permissions: ["posts:read", "posts:write"] };

const serve = (router: RhythmRouter<any>) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const withUser = (user: User | null) => new RhythmRouter().use(attachUser(() => user));

describe("authorize()", () => {
  test("runs the handler when the check passes and 403s when it fails", async () => {
    const make = (allowed: boolean) =>
      withUser(editor).get(
        "/thing",
        authorize(() => allowed),
        (ctx) => ctx.text("ok"),
      );

    const allowed = await serve(make(true))(new Request("http://localhost/thing"));
    expect(await allowed.text()).toBe("ok");

    const denied = await serve(make(false))(new Request("http://localhost/thing"));
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("Forbidden");
  });

  test("supports async checks reading the context", async () => {
    const router = withUser(editor).get(
      "/posts/:id",
      authorize<RhythmHttpContext & RhythmRouterContext>(async (ctx) => ctx.params.id === "1"),
      (ctx) => ctx.text("post"),
    );
    const handler = serve(router);

    expect((await handler(new Request("http://localhost/posts/1"))).status).toBe(200);
    expect((await handler(new Request("http://localhost/posts/2"))).status).toBe(403);
  });

  test("honors custom status and message", async () => {
    const router = withUser(editor).get(
      "/thing",
      authorize(() => false, { status: 404, message: "hidden" }),
      (ctx) => ctx.text("ok"),
    );

    const res = await serve(router)(new Request("http://localhost/thing"));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("hidden");
  });

  test("rejects a non-function check", () => {
    expect(() => authorize(null as never)).toThrow(TypeError);
  });
});

describe("requireRoles()", () => {
  test("matches any of the required roles by default", async () => {
    const router = withUser(editor).get("/write", requireRoles(["admin", "editor"]), (ctx) => ctx.text("ok"));

    const res = await serve(router)(new Request("http://localhost/write"));

    expect(await res.text()).toBe("ok");
  });

  test("403s when no required role is held", async () => {
    const router = withUser(editor).get("/admin", requireRoles(["admin"]), (ctx) => ctx.text("ok"));

    const res = await serve(router)(new Request("http://localhost/admin"));

    expect(res.status).toBe(403);
  });

  test("match 'all' requires every listed role", async () => {
    const router = withUser(editor).get("/both", requireRoles(["editor", "admin"], { match: "all" }), (ctx) =>
      ctx.text("ok"),
    );

    const res = await serve(router)(new Request("http://localhost/both"));

    expect(res.status).toBe(403);
  });

  test("401s when there is no user at all", async () => {
    const router = withUser(null).get("/write", requireRoles(["editor"]), (ctx) => ctx.text("ok"));

    const res = await serve(router)(new Request("http://localhost/write"));

    expect(res.status).toBe(401);
  });

  test("a custom roles extractor overrides the default user.roles", async () => {
    type Account = { id: string; access: { role: string }[] };
    const account: Account = { id: "1", access: [{ role: "owner" }] };
    const router = new RhythmRouter()
      .use(attachUser(() => account))
      .get(
        "/manage",
        requireRoles<Account>(["owner"], { roles: (user) => user.access.map((entry) => entry.role) }),
        (ctx) => ctx.text("ok"),
      );

    const res = await serve(router)(new Request("http://localhost/manage"));

    expect(await res.text()).toBe("ok");
  });

  test("a user without a roles field simply holds no roles", async () => {
    const router = new RhythmRouter()
      .use(attachUser(() => ({ id: "1" })))
      .get("/write", requireRoles(["editor"]), (ctx) => ctx.text("ok"));

    const res = await serve(router)(new Request("http://localhost/write"));

    expect(res.status).toBe(403);
  });
});

describe("requirePermissions()", () => {
  test("requires every listed permission by default", async () => {
    const make = (required: string[]) =>
      withUser(editor).get("/posts", requirePermissions(required), (ctx) => ctx.text("ok"));

    const both = await serve(make(["posts:read", "posts:write"]))(new Request("http://localhost/posts"));
    expect(await both.text()).toBe("ok");

    const missing = await serve(make(["posts:read", "posts:delete"]))(new Request("http://localhost/posts"));
    expect(missing.status).toBe(403);
  });

  test("match 'any' passes on a single held permission", async () => {
    const router = withUser(editor).get(
      "/posts",
      requirePermissions(["posts:delete", "posts:write"], { match: "any" }),
      (ctx) => ctx.text("ok"),
    );

    const res = await serve(router)(new Request("http://localhost/posts"));

    expect(await res.text()).toBe("ok");
  });

  test("401s when there is no user at all", async () => {
    const router = withUser(null).get("/posts", requirePermissions(["posts:read"]), (ctx) => ctx.text("ok"));

    const res = await serve(router)(new Request("http://localhost/posts"));

    expect(res.status).toBe(401);
  });
});
