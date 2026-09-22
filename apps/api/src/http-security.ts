import type { FastifyInstance, FastifyReply } from 'fastify';

const LOCAL_DEVELOPMENT_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';

export interface HttpSecurityOptions {
  nodeEnv: 'development' | 'test' | 'production';
  webOrigin: string;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string, options: HttpSecurityOptions): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (normalized === options.webOrigin) return true;
  return options.nodeEnv !== 'production' && LOCAL_DEVELOPMENT_ORIGINS.has(normalized);
}

function addSecurityHeaders(reply: FastifyReply, production: boolean): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  reply.header('x-frame-options', 'DENY');
  reply.header('content-security-policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (production) reply.header('strict-transport-security', 'max-age=31536000');
}

export function registerHttpSecurity(app: FastifyInstance, options: HttpSecurityOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    addSecurityHeaders(reply, options.nodeEnv === 'production');

    const origin = request.headers.origin;
    if (!origin) {
      if (request.method === 'OPTIONS') return reply.code(403).send({ error: 'CORS origin not allowed' });
      return;
    }

    reply.header('vary', 'Origin');
    if (!isAllowedOrigin(origin, options)) return reply.code(403).send({ error: 'CORS origin not allowed' });

    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-methods', ALLOWED_METHODS);
    reply.header('access-control-allow-headers', ALLOWED_HEADERS);

    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
}
