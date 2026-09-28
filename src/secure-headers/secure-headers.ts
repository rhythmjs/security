import type { Middleware } from "@rhythmjs/rhythm";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface SecureHeadersOptions {
  contentSecurityPolicy?: string | false;
  crossOriginEmbedderPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  referrerPolicy?: string | false;
  strictTransportSecurity?: string | false;
  xContentTypeOptions?: string | false;
  xDnsPrefetchControl?: string | false;
  xDownloadOptions?: string | false;
  xFrameOptions?: string | false;
  xPermittedCrossDomainPolicies?: string | false;
  xXssProtection?: string | false;
}

const HEADER_DEFAULTS: [keyof SecureHeadersOptions, string, string | null][] = [
  ["contentSecurityPolicy", "content-security-policy", null],
  ["crossOriginEmbedderPolicy", "cross-origin-embedder-policy", null],
  ["crossOriginOpenerPolicy", "cross-origin-opener-policy", "same-origin"],
  ["crossOriginResourcePolicy", "cross-origin-resource-policy", "same-origin"],
  ["referrerPolicy", "referrer-policy", "no-referrer"],
  ["strictTransportSecurity", "strict-transport-security", "max-age=15552000; includeSubDomains"],
  ["xContentTypeOptions", "x-content-type-options", "nosniff"],
  ["xDnsPrefetchControl", "x-dns-prefetch-control", "off"],
  ["xDownloadOptions", "x-download-options", "noopen"],
  ["xFrameOptions", "x-frame-options", "SAMEORIGIN"],
  ["xPermittedCrossDomainPolicies", "x-permitted-cross-domain-policies", "none"],
  ["xXssProtection", "x-xss-protection", "0"],
];

export function secureHeaders(options: SecureHeadersOptions = {}): Middleware<RhythmHttpContext> {
  const resolved: [string, string][] = [];
  for (const [key, name, defaultValue] of HEADER_DEFAULTS) {
    const configured = key in options ? options[key] : defaultValue;
    if (typeof configured === "string") resolved.push([name, configured]);
  }

  return async (ctx, next) => {
    await next();
    for (const [name, value] of resolved) ctx.response.headers.set(name, value);
  };
}
