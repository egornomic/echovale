export const responsePolicies = {
  application: {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: http: https:",
      "media-src 'self' blob: http: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self' https://www.youtube.com",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  },
  webFeedSnapshot: {
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
      "font-src data:",
      "media-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
    "Cross-Origin-Resource-Policy": "same-origin",
  },
};

declare module "fastify" {
  interface FastifyContextConfig {
    responsePolicy?: keyof typeof responsePolicies;
  }
}
