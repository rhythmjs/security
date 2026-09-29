import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import type { UserContext } from "../authentication/authentication";

export interface AuthorizeOptions {
  status?: number;
  message?: string;
}

export interface RequireRolesOptions<TUser = unknown> extends AuthorizeOptions {
  match?: "any" | "all";
  roles?: (user: TUser) => readonly string[];
}

export interface RequirePermissionsOptions<TUser = unknown> extends AuthorizeOptions {
  match?: "any" | "all";
  permissions?: (user: TUser) => readonly string[];
}

export function authorize<TContext extends RhythmHttpContext>(
  check: (ctx: TContext) => boolean | Promise<boolean>,
  options: AuthorizeOptions = {},
): Middleware<TContext> {
  if (typeof check !== "function") throw new TypeError("authorize check must be a function!");
  return async (ctx, next) => {
    if (!(await check(ctx))) {
      ctx.error(options.status ?? 403, options.message);
      return;
    }
    await next();
  };
}

function requireGranted<TUser>(
  required: readonly string[],
  grantedOf: (user: TUser) => readonly string[],
  match: "any" | "all",
  options: AuthorizeOptions,
): Middleware<RhythmHttpContext & UserContext<TUser>> {
  return async (ctx, next) => {
    if (ctx.user === null || ctx.user === undefined) {
      ctx.error(401);
      return;
    }
    const granted = new Set(grantedOf(ctx.user));
    const allowed =
      match === "all" ? required.every((entry) => granted.has(entry)) : required.some((entry) => granted.has(entry));
    if (!allowed) {
      ctx.error(options.status ?? 403, options.message);
      return;
    }
    await next();
  };
}

export function requireRoles<TUser = unknown>(
  required: readonly string[],
  options: RequireRolesOptions<TUser> = {},
): Middleware<RhythmHttpContext & UserContext<TUser>> {
  const rolesOf = options.roles ?? ((user: TUser) => (user as { roles?: readonly string[] }).roles ?? []);
  return requireGranted(required, rolesOf, options.match ?? "any", options);
}

export function requirePermissions<TUser = unknown>(
  required: readonly string[],
  options: RequirePermissionsOptions<TUser> = {},
): Middleware<RhythmHttpContext & UserContext<TUser>> {
  const permissionsOf =
    options.permissions ?? ((user: TUser) => (user as { permissions?: readonly string[] }).permissions ?? []);
  return requireGranted(required, permissionsOf, options.match ?? "all", options);
}
