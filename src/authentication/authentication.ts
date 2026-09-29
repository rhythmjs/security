import type { DeriveMiddleware, Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface UserContext<TUser = unknown> {
  user: TUser | null;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

export interface RequireAuthenticationOptions {
  redirectTo?: string;
  status?: number;
  message?: string;
  challenge?: string;
}

export function attachUser<TUser>(
  resolve: (ctx: RhythmHttpContext) => TUser | null | undefined | Promise<TUser | null | undefined>,
): DeriveMiddleware<RhythmHttpContext, UserContext<TUser>> {
  if (typeof resolve !== "function") throw new TypeError("attachUser resolver must be a function!");
  const middleware: Middleware<RhythmHttpContext> = async (ctx, next) => {
    const user = (await resolve(ctx)) ?? null;
    Object.assign(ctx, { user });
    await next();
  };
  return middleware as DeriveMiddleware<RhythmHttpContext, UserContext<TUser>>;
}

export function isAuthenticated<TUser>(ctx: UserContext<TUser>): ctx is UserContext<TUser> & { user: TUser } {
  return ctx.user !== null && ctx.user !== undefined;
}

export function requireAuthentication<TUser = unknown>(
  options: RequireAuthenticationOptions = {},
): DeriveMiddleware<RhythmHttpContext & UserContext<TUser>, { user: TUser }> {
  const middleware: Middleware<RhythmHttpContext & UserContext<TUser>> = async (ctx, next) => {
    if (!isAuthenticated(ctx)) {
      if (options.redirectTo) {
        ctx.redirect(options.redirectTo);
        return;
      }
      if (options.challenge) ctx.response.headers.set("www-authenticate", options.challenge);
      ctx.error(options.status ?? 401, options.message);
      return;
    }
    await next();
  };
  return middleware as DeriveMiddleware<RhythmHttpContext & UserContext<TUser>, { user: TUser }>;
}

export function redirectIfAuthenticated(to: string): Middleware<RhythmHttpContext & UserContext> {
  return async (ctx, next) => {
    if (isAuthenticated(ctx)) {
      ctx.redirect(to);
      return;
    }
    await next();
  };
}

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !/^bearer /i.test(header)) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function getBasicCredentials(request: Request): BasicCredentials | null {
  const header = request.headers.get("authorization");
  if (!header || !/^basic /i.test(header)) return null;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6).trim()), (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}
