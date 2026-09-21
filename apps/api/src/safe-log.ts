const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_ERROR_STACK_LENGTH = 4_000;

const secretNamePattern = '(?:OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|INTERNAL_CRON_SECRET|MONITORING_WATCHDOG_SECRET|RESEND_API_KEY|SUPABASE_DB_PASSWORD|DATABASE_URL)';

/**
 * Redacts credentials and personal contact data from an otherwise useful
 * diagnostic string. This is a final logging boundary, not an authorization or
 * data-validation mechanism.
 */
export function redactSensitiveLogText(value: string, maxLength = MAX_ERROR_MESSAGE_LENGTH): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;'"\])}]+/giu, (match) => `${match.split(/\s/u, 1)[0]} [REDACTED]`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_JWT]')
    .replace(/https:\/\/api\.telegram\.org\/(?:file\/)?bot[^/\s]+/giu, 'https://api.telegram.org/[REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|apikey|api_key|signature|sig|secret|x-amz-signature|x-amz-credential)=)[^&\s#]+/giu, '$1[REDACTED]')
    .replace(new RegExp(`(${secretNamePattern}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`, 'giu'), '$1[REDACTED]')
    .replace(/("(?:authorization|cookie|set-cookie|token|access_token|refresh_token|api[_-]?key|secret|password)"\s*:\s*")[^"]*"/giu, '$1[REDACTED]"')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[REDACTED_EMAIL]')
    .replace(/\b[0-9A-F]{32}\b/giu, '[REDACTED_CODE]')
    .slice(0, maxLength);
}

type ErrorRecord = Record<string, unknown>;

function safeScalar(value: unknown, maxLength = 128): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const sanitized = redactSensitiveLogText(value, maxLength);
  return sanitized || undefined;
}

/**
 * Converts any thrown value into a flat allow-listed object. Arbitrary Error
 * fields such as request, response, headers, body, config and provider payloads
 * are intentionally never serialized.
 */
export function safeErrorLog(error: unknown): {
  name: string;
  message: string;
  code?: string | number;
  status?: string | number;
  requestId?: string | number;
  stack?: string;
} {
  const record: ErrorRecord = error && typeof error === 'object' ? error as ErrorRecord : {};
  const rawMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  const rawName = error instanceof Error ? error.name : 'UnknownError';
  const code = safeScalar(record.code);
  const status = safeScalar(record.status ?? record.statusCode);
  const requestId = safeScalar(record.request_id ?? record.requestId);
  const stack = error instanceof Error && error.stack
    ? redactSensitiveLogText(error.stack, MAX_ERROR_STACK_LENGTH)
    : undefined;
  return {
    name: redactSensitiveLogText(rawName, 128),
    message: redactSensitiveLogText(rawMessage),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(stack ? { stack } : {}),
  };
}

/** Keeps request logs useful while removing query strings and route identifiers. */
export function safeRequestPath(rawUrl: string | undefined): string {
  if (!rawUrl) return '/';
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://internal.invalid').pathname;
  } catch {
    return '/invalid-path';
  }
  if (/^\/internal\/reports\/monthly\/run\/[^/]+$/u.test(pathname)) {
    return '/internal/reports/monthly/run/:workspaceId';
  }
  if (/^\/internal\/reports\/monthly\/[^/]+$/u.test(pathname)) {
    return '/internal/reports/monthly/:telegramUserId';
  }
  return pathname;
}
