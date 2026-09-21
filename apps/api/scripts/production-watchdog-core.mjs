import { createHash } from 'node:crypto';

export const terminalIncidentCodes = new Set([
  'terminal_async_job_failed',
  'terminal_report_delivery_failed',
  'terminal_warranty_reminder_failed',
]);

export function watchdogFingerprint(code, discriminator = code) {
  return createHash('sha256').update(`ofa-watchdog:${code}:${discriminator}`).digest('hex');
}

export function genericIncident(code, { observedAt = new Date().toISOString(), autoResolve = true } = {}) {
  return { code, fingerprint: watchdogFingerprint(code), observedAt, autoResolve };
}

export function redactWatchdogText(value) {
  return String(value)
    .replace(/\b(?:Bearer|Basic)\s+\S+/giu, (match) => `${match.split(/\s/u, 1)[0]} [REDACTED]`)
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/giu, 'https://api.telegram.org/[REDACTED]')
    .replace(/((?:token|secret|password|authorization|apikey|api_key)\s*[:=]\s*)[^\s,;}]+/giu, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_JWT]')
    .slice(0, 1_000);
}

export async function confirmHealth(check, { attempts = 3, delay = async () => {}, now = () => new Date() } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (await check()) return null;
    } catch {
      // Deliberately continue to the confirmation attempt without logging details.
    }
    if (attempt < attempts) await delay(attempt);
  }
  return genericIncident('production_api_unavailable', { observedAt: now().toISOString() });
}

export function workflowFreshnessIncidents({ name, latestRun, latestSuccess, maxAgeMs, now = new Date() }) {
  const incidents = [];
  const prefix = name === 'backup' ? 'production_backup' : 'restore_verification';
  const latestSuccessAt = latestSuccess?.updated_at ? Date.parse(latestSuccess.updated_at) : Number.NaN;
  if (!Number.isFinite(latestSuccessAt) || now.getTime() - latestSuccessAt > maxAgeMs) {
    incidents.push(genericIncident(`${prefix}_stale`, { observedAt: now.toISOString() }));
  }
  if (latestRun?.conclusion === 'failure'
    && (!latestSuccess?.updated_at || Date.parse(latestRun.updated_at) > latestSuccessAt)) {
    incidents.push(genericIncident(`${prefix}_workflow_failed`, { observedAt: latestRun.updated_at ?? now.toISOString() }));
  }
  return incidents;
}

export function filterPreActivationTerminalIncidents(incidents, activatedAt) {
  const threshold = Date.parse(activatedAt);
  if (!Number.isFinite(threshold)) throw new Error('WATCHDOG_ACTIVATED_AT must be a valid ISO timestamp');
  return incidents.filter((incident) => !terminalIncidentCodes.has(incident.code)
    || Date.parse(incident.observedAt) >= threshold);
}

export function issueMarker(fingerprint, autoResolve = true) {
  return `<!-- ofa-watchdog:${fingerprint}:${autoResolve ? 'dynamic' : 'persistent'} -->`;
}

export function parseWatchdogIssue(issue) {
  const match = /<!-- ofa-watchdog:([a-f0-9]{64}):(dynamic|persistent) -->/u.exec(issue.body ?? '');
  return match ? { ...issue, fingerprint: match[1], autoResolve: match[2] === 'dynamic' } : null;
}

export function planIncidentIssueActions(incidents, issues) {
  const currentByFingerprint = new Map(incidents.map((incident) => [incident.fingerprint, incident]));
  const issueByFingerprint = new Map(issues.map(parseWatchdogIssue).filter(Boolean).map((issue) => [issue.fingerprint, issue]));
  const actions = [];
  let alertRequired = false;

  for (const incident of incidents) {
    const existing = issueByFingerprint.get(incident.fingerprint);
    if (!existing) {
      actions.push({ type: 'create', incident });
      alertRequired = true;
    } else if (existing.state === 'closed' && incident.autoResolve) {
      actions.push({ type: 'reopen', issueNumber: existing.number, incident });
      alertRequired = true;
    }
  }

  for (const issue of issueByFingerprint.values()) {
    if (issue.state !== 'open') continue;
    const current = currentByFingerprint.get(issue.fingerprint);
    if (!current && issue.autoResolve) actions.push({ type: 'close', issueNumber: issue.number });
  }

  return { actions, alertRequired };
}

export function assertSafeIncident(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid watchdog incident');
  if (typeof value.code !== 'string' || !/^[a-z0-9_]{3,96}$/u.test(value.code)) throw new Error('Invalid watchdog incident code');
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) throw new Error('Invalid watchdog fingerprint');
  if (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) throw new Error('Invalid watchdog timestamp');
  if (typeof value.autoResolve !== 'boolean') throw new Error('Invalid watchdog resolution mode');
  return value;
}
