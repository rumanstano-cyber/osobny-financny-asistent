import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmHealth,
  filterPreActivationTerminalIncidents,
  genericIncident,
  issueMarker,
  planIncidentIssueActions,
  redactWatchdogText,
  workflowFreshnessIncidents,
} from './production-watchdog-core.mjs';

test('healthy state produces no health alert', async () => {
  assert.equal(await confirmHealth(async () => true), null);
});

test('one transient health failure is confirmed before alerting', async () => {
  let calls = 0;
  const result = await confirmHealth(async () => { calls += 1; return calls > 1; });
  assert.equal(result, null);
  assert.equal(calls, 2);
});

test('confirmed health outage creates one sanitized incident', async () => {
  let calls = 0;
  const result = await confirmHealth(async () => { calls += 1; return false; });
  assert.equal(calls, 3);
  assert.equal(result?.code, 'production_api_unavailable');
});

test('new terminal incidents alert once and the same issue is not recreated', () => {
  const incident = genericIncident('terminal_async_job_failed', { autoResolve: false });
  const first = planIncidentIssueActions([incident], []);
  assert.equal(first.alertRequired, true);
  assert.equal(first.actions[0]?.type, 'create');
  const existing = [{ number: 10, state: 'open', body: issueMarker(incident.fingerprint, false) }];
  const repeated = planIncidentIssueActions([incident], existing);
  assert.equal(repeated.alertRequired, false);
  assert.deepEqual(repeated.actions, []);
});

test('terminal async, report and reminder failures each create a distinct alert', () => {
  const incidents = [
    genericIncident('terminal_async_job_failed', { autoResolve: false }),
    genericIncident('terminal_report_delivery_failed', { autoResolve: false }),
    genericIncident('terminal_warranty_reminder_failed', { autoResolve: false }),
  ];
  const plan = planIncidentIssueActions(incidents, []);
  assert.equal(plan.alertRequired, true);
  assert.equal(plan.actions.filter((action) => action.type === 'create').length, 3);
});

test('resolved dynamic incidents close and later recurrence reopens the issue', () => {
  const incident = genericIncident('telegram_webhook_url_mismatch');
  const openIssue = [{ number: 11, state: 'open', body: issueMarker(incident.fingerprint) }];
  assert.deepEqual(planIncidentIssueActions([], openIssue).actions, [{ type: 'close', issueNumber: 11 }]);
  const closedIssue = [{ number: 11, state: 'closed', body: issueMarker(incident.fingerprint) }];
  const recurrence = planIncidentIssueActions([incident], closedIssue);
  assert.equal(recurrence.alertRequired, true);
  assert.equal(recurrence.actions[0]?.type, 'reopen');
});

test('stale backup and restore verification create alerts', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  assert.equal(workflowFreshnessIncidents({ name: 'backup', latestSuccess: { updated_at: '2026-09-19T00:00:00.000Z' }, maxAgeMs: 36 * 3_600_000, now })[0]?.code, 'production_backup_stale');
  assert.equal(workflowFreshnessIncidents({ name: 'restore', latestSuccess: { updated_at: '2026-08-01T00:00:00.000Z' }, maxAgeMs: 35 * 86_400_000, now })[0]?.code, 'restore_verification_stale');
});

test('pre-activation terminal failures are baselined but live incidents remain', () => {
  const oldTerminal = { ...genericIncident('terminal_report_delivery_failed', { autoResolve: false }), observedAt: '2026-09-20T10:00:00.000Z' };
  const webhook = genericIncident('telegram_webhook_url_mismatch');
  assert.deepEqual(filterPreActivationTerminalIncidents([oldTerminal, webhook], '2026-09-21T00:00:00.000Z'), [webhook]);
});

test('watchdog text redaction removes secrets, tokens and authorization values', () => {
  const sanitized = redactWatchdogText('Bearer abc.def SECRET=hidden token=123 https://api.telegram.org/bot123:SECRET/getWebhookInfo');
  assert.doesNotMatch(sanitized, /abc\.def|hidden|123:SECRET/u);
  assert.match(sanitized, /REDACTED/u);
});
