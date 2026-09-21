import {
  assertSafeIncident,
  confirmHealth,
  filterPreActivationTerminalIncidents,
  genericIncident,
  issueMarker,
  planIncidentIssueActions,
  redactWatchdogText,
  workflowFreshnessIncidents,
} from './production-watchdog-core.mjs';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = required('BASE_URL').replace(/\/$/u, '');
const monitoringSecret = required('MONITORING_WATCHDOG_SECRET');
const githubToken = required('GITHUB_TOKEN');
const repository = required('GITHUB_REPOSITORY');
const activatedAt = required('WATCHDOG_ACTIVATED_AT');
const githubApi = 'https://api.github.com';

async function github(path, options = {}) {
  const response = await fetch(`${githubApi}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'x-github-api-version': '2022-11-28',
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function healthCheck() {
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return false;
  const body = await response.json().catch(() => null);
  return body?.status === 'ok';
}

async function operationalSnapshot() {
  const response = await fetch(`${baseUrl}/internal/monitoring/snapshot`, {
    headers: { 'x-monitoring-watchdog-secret': monitoringSecret },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Monitoring snapshot returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.version !== 1 || !Array.isArray(payload.incidents)) throw new Error('Monitoring snapshot response is invalid');
  return payload.incidents.map(assertSafeIncident);
}

async function workflowRuns(workflow) {
  const encoded = encodeURIComponent(workflow);
  const [latest, successful] = await Promise.all([
    github(`/repos/${repository}/actions/workflows/${encoded}/runs?per_page=1`),
    github(`/repos/${repository}/actions/workflows/${encoded}/runs?status=success&per_page=1`),
  ]);
  return {
    latestRun: latest?.workflow_runs?.[0] ?? null,
    latestSuccess: successful?.workflow_runs?.[0] ?? null,
  };
}

const titles = {
  production_api_unavailable: 'Produkčné API je nedostupné',
  monitoring_snapshot_unavailable: 'Prevádzkový snapshot nie je dostupný',
  telegram_webhook_api_unavailable: 'Telegram webhook sa nedá overiť',
  telegram_webhook_url_mismatch: 'Telegram webhook má nesprávnu URL',
  telegram_webhook_delivery_error: 'Telegram hlási chybu doručovania webhooku',
  telegram_webhook_pending_updates_high: 'Telegram má neprimeraný počet čakajúcich updateov',
  terminal_async_job_failed: 'OCR alebo voice job skončil terminálne',
  terminal_report_delivery_failed: 'Report skončil terminálne',
  terminal_warranty_reminder_failed: 'Warranty reminder skončil terminálne',
  critical_cron_missing: 'Kritický Supabase Cron chýba',
  critical_cron_inactive: 'Kritický Supabase Cron je neaktívny',
  critical_cron_overdue: 'Kritický Supabase Cron nemá čerstvý úspešný beh',
  critical_cron_repeated_failures: 'Kritický Supabase Cron opakovane zlyhal',
  production_backup_stale: 'Produkčný backup nie je čerstvý',
  production_backup_workflow_failed: 'Produkčný backup workflow zlyhal',
  restore_verification_stale: 'Restore verification je zastaraný',
  restore_verification_workflow_failed: 'Restore verification workflow zlyhal',
  github_workflow_status_unavailable: 'Stav backup workflowov sa nedá overiť',
};

function issueBody(incident) {
  const title = titles[incident.code] ?? 'Neznámy prevádzkový incident';
  return `${issueMarker(incident.fingerprint, incident.autoResolve)}\n\n`+
    `**Typ:** ${title}\n\n`+
    `**Kód:** \`${incident.code}\`\n\n`+
    `**Prvý zistený stav:** ${incident.observedAt}\n\n`+
    'Watchdog zámerne neukladá používateľské, finančné ani autentifikačné údaje. Overte Render/Supabase/GitHub prevádzkový stav.';
}

async function applyIssueActions(actions) {
  for (const action of actions) {
    if (action.type === 'create') {
      await github(`/repos/${repository}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `[Watchdog] ${titles[action.incident.code] ?? action.incident.code}`,
          body: issueBody(action.incident),
        }),
      });
    } else if (action.type === 'reopen') {
      await github(`/repos/${repository}/issues/${action.issueNumber}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'open', body: issueBody(action.incident) }),
      });
    } else if (action.type === 'close') {
      await github(`/repos/${repository}/issues/${action.issueNumber}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      });
    }
  }
}

async function main() {
  const incidents = [];
  const healthIncident = await confirmHealth(healthCheck, {
    attempts: 3,
    delay: (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 20_000)),
  });
  if (healthIncident) incidents.push(healthIncident);

  if (!healthIncident) {
    try {
      incidents.push(...await operationalSnapshot());
    } catch {
      incidents.push(genericIncident('monitoring_snapshot_unavailable'));
    }
  }

  try {
    const [backup, restore] = await Promise.all([
      workflowRuns('production-backup.yml'),
      workflowRuns('production-backup-restore-test.yml'),
    ]);
    incidents.push(...workflowFreshnessIncidents({ name: 'backup', ...backup, maxAgeMs: 36 * 60 * 60 * 1_000 }));
    incidents.push(...workflowFreshnessIncidents({ name: 'restore', ...restore, maxAgeMs: 35 * 24 * 60 * 60 * 1_000 }));
  } catch {
    incidents.push(genericIncident('github_workflow_status_unavailable'));
  }

  const current = filterPreActivationTerminalIncidents(incidents, activatedAt);
  const issues = await github(`/repos/${repository}/issues?state=all&per_page=100`);
  const plan = planIncidentIssueActions(current, issues ?? []);
  await applyIssueActions(plan.actions);

  console.info(JSON.stringify({
    checked: true,
    incidentCount: current.length,
    newAlertCount: plan.actions.filter((action) => action.type === 'create' || action.type === 'reopen').length,
    resolvedCount: plan.actions.filter((action) => action.type === 'close').length,
  }));
  if (plan.alertRequired) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Production watchdog failed safely', { error: redactWatchdogText(error instanceof Error ? error.message : error) });
  process.exitCode = 1;
});
