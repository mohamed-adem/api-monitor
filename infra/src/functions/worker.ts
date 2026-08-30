import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { Assertion, CheckJob, CheckResult, Monitor } from '../shared/model.js';
import { assertPublicDestination, valueAtPath } from '../shared/validation.js';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const sns = new SNSClient({});
const monitorsTable = process.env.MONITORS_TABLE!;
const checksTable = process.env.CHECKS_TABLE!;
const incidentsTable = process.env.INCIDENTS_TABLE!;
const aggregatesTable = process.env.AGGREGATES_TABLE!;
const alertTopicArn = process.env.ALERT_TOPIC_ARN!;
const failureThreshold = Number(process.env.FAILURE_THRESHOLD || 2);
const retentionDays = Number(process.env.CHECK_RETENTION_DAYS || 30);

function assertionsPass(assertions: Assertion[], bodyText: string): { ok: boolean; reason: string } {
  let json: unknown;
  const parseJson = () => { if (json !== undefined) return json; try { json = JSON.parse(bodyText); } catch { json = null; } return json; };
  for (const assertion of assertions || []) {
    if (assertion.type === 'contains_text' && !bodyText.includes(assertion.value)) return { ok: false, reason: `Response did not contain: ${assertion.value}` };
    if (assertion.type === 'json_path_exists' && valueAtPath(parseJson(), assertion.path) === undefined) return { ok: false, reason: `JSON path does not exist: ${assertion.path}` };
    if (assertion.type === 'json_path_equals') {
      const actual = valueAtPath(parseJson(), assertion.path);
      if (actual !== assertion.value) return { ok: false, reason: `JSON path ${assertion.path} did not equal the expected value` };
    }
  }
  return { ok: true, reason: assertions.length ? 'All assertions passed' : 'Healthy response' };
}

async function performCheck(monitor: Monitor): Promise<CheckResult> {
  await assertPublicDestination(monitor.url);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitor.timeoutMs);
  try {
    const response = await fetch(monitor.url, { method: monitor.method, signal: controller.signal, redirect: 'manual', headers: { 'user-agent': 'Pulse-API-Monitor/0.1' } });
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 1_000_000) return { ok: false, statusCode: response.status, latencyMs: Date.now() - started, reason: 'Response exceeded 1 MB limit' };
    const bodyText = (await response.text()).slice(0, 1_000_000);
    const latencyMs = Date.now() - started;
    if (response.status !== monitor.expectedStatus) return { ok: false, statusCode: response.status, latencyMs, reason: `Expected status ${monitor.expectedStatus}, received ${response.status}` };
    const assertion = assertionsPass(monitor.assertions, bodyText);
    return { ...assertion, statusCode: response.status, latencyMs };
  } catch (error) {
    return { ok: false, statusCode: null, latencyMs: Date.now() - started, reason: error instanceof Error && error.name === 'AbortError' ? `Timed out after ${monitor.timeoutMs}ms` : `Request failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  } finally { clearTimeout(timer); }
}

async function processJob(job: CheckJob): Promise<void> {
  const checkKey = { monitorId: job.monitorId, checkedAt: `${job.requestedAt}#${job.jobId}` };
  const existingCheck = await db.send(new GetCommand({ TableName: checksTable, Key: checkKey }));
  if (existingCheck.Item) {
    if (existingCheck.Item.notification && !existingCheck.Item.notificationSent) await deliverNotification(checkKey, existingCheck.Item.notification as Notification);
    return;
  }
  const monitorResult = await db.send(new GetCommand({ TableName: monitorsTable, Key: { userId: job.userId, monitorId: job.monitorId } }));
  const monitor = monitorResult.Item as Monitor | undefined;
  if (!monitor || !monitor.enabled) return;
  if (monitor.maintenanceWindow && Date.now() >= Date.parse(monitor.maintenanceWindow.startsAt) && Date.now() < Date.parse(monitor.maintenanceWindow.endsAt)) return;
  const checkedAt = new Date().toISOString();
  const result = await performCheck(monitor);
  const expiresAt = Math.floor(Date.now() / 1000) + retentionDays * 86400;
  const nextFailureStreak = result.ok ? 0 : (monitor.failureStreak || 0) + 1;
  const nextStatus = result.ok ? 'UP' : nextFailureStreak >= failureThreshold ? 'DOWN' : 'DEGRADED';
  let activeIncidentId = monitor.activeIncidentId;
  let notification: Notification | undefined;
  const transaction: NonNullable<TransactWriteCommandInput['TransactItems']> = [];

  if (!result.ok && nextFailureStreak === failureThreshold && !activeIncidentId) {
    activeIncidentId = `inc_${job.jobId}`;
    transaction.push({ Put: { TableName: incidentsTable, Item: { monitorId: monitor.monitorId, incidentId: activeIncidentId, userId: monitor.userId, userStatus: `${monitor.userId}#OPEN`, status: 'OPEN', startedAt: checkedAt, reason: result.reason, openingCheckJobId: job.jobId }, ConditionExpression: 'attribute_not_exists(incidentId)' } });
    notification = { eventType: 'incident_opened', userId: monitor.userId, subject: `Pulse incident: ${monitor.name}`, message: `${monitor.name} is down. ${result.reason}\n${monitor.url}` };
  }

  if (result.ok && activeIncidentId) {
    transaction.push({ Update: { TableName: incidentsTable, Key: { monitorId: monitor.monitorId, incidentId: activeIncidentId }, UpdateExpression: 'SET #status = :resolved, userStatus = :userStatus, resolvedAt = :resolvedAt', ConditionExpression: '#status = :open', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':open': 'OPEN', ':resolved': 'RESOLVED', ':userStatus': `${monitor.userId}#RESOLVED`, ':resolvedAt': checkedAt } } });
    notification = { eventType: 'incident_resolved', userId: monitor.userId, subject: `Pulse recovery: ${monitor.name}`, message: `${monitor.name} recovered at ${checkedAt}.\n${monitor.url}` };
    activeIncidentId = undefined;
  }

  const updateExpression = activeIncidentId
    ? 'SET #status = :status, failureStreak = :streak, lastCheckedAt = :checkedAt, lastLatencyMs = :latency, lastStatusCode = :statusCode, activeIncidentId = :incidentId, updatedAt = :checkedAt, lastProcessedJobId = :jobId'
    : 'SET #status = :status, failureStreak = :streak, lastCheckedAt = :checkedAt, lastLatencyMs = :latency, lastStatusCode = :statusCode, updatedAt = :checkedAt, lastProcessedJobId = :jobId REMOVE activeIncidentId';
  transaction.unshift(
    { Put: { TableName: checksTable, Item: { ...checkKey, observedAt: checkedAt, jobId: job.jobId, userId: job.userId, source: job.source, ...result, notification, notificationSent: false, expiresAt }, ConditionExpression: 'attribute_not_exists(checkedAt)' } },
    { Update: { TableName: monitorsTable, Key: { userId: monitor.userId, monitorId: monitor.monitorId }, UpdateExpression: updateExpression, ConditionExpression: 'enabled = :enabled AND (attribute_not_exists(lastProcessedJobId) OR lastProcessedJobId <> :jobId)', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':enabled': true, ':jobId': job.jobId, ':status': nextStatus, ':streak': nextFailureStreak, ':checkedAt': checkedAt, ':latency': result.latencyMs, ':statusCode': result.statusCode ?? -1, ...(activeIncidentId ? { ':incidentId': activeIncidentId } : {}) } } }
  );
  const hourStart = new Date(checkedAt); hourStart.setUTCMinutes(0, 0, 0);
  const dayStart = checkedAt.slice(0, 10);
  const aggregateValues = { ':userId': monitor.userId, ':one': 1, ':success': result.ok ? 1 : 0, ':failure': result.ok ? 0 : 1, ':latency': result.latencyMs, ':updatedAt': checkedAt, ':expiresAt': Math.floor(Date.now() / 1000) + 90 * 86400 };
  for (const [bucketKey, bucketType, bucketStart] of [
    [`HOUR#${hourStart.toISOString()}`, 'HOUR', hourStart.toISOString()],
    [`DAY#${dayStart}`, 'DAY', dayStart]
  ]) transaction.push({ Update: { TableName: aggregatesTable, Key: { monitorId: monitor.monitorId, bucketKey }, UpdateExpression: 'SET userId = :userId, bucketType = :bucketType, bucketStart = :bucketStart, updatedAt = :updatedAt, expiresAt = :expiresAt ADD totalChecks :one, successCount :success, failureCount :failure, latencySumMs :latency', ExpressionAttributeValues: { ...aggregateValues, ':bucketType': bucketType, ':bucketStart': bucketStart } } });
  try { await db.send(new TransactWriteCommand({ TransactItems: transaction })); }
  catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      const duplicate = await db.send(new GetCommand({ TableName: checksTable, Key: checkKey }));
      if (duplicate.Item) return;
    }
    throw error;
  }
  if (notification) await deliverNotification(checkKey, notification);
  console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'Pulse/ApiMonitor', Dimensions: [['MonitorId']], Metrics: [{ Name: 'Latency', Unit: 'Milliseconds' }, { Name: 'Success', Unit: 'Count' }] }] }, MonitorId: monitor.monitorId, Latency: result.latencyMs, Success: result.ok ? 1 : 0, reason: result.reason }));
}

interface Notification { eventType: 'incident_opened' | 'incident_resolved'; userId: string; subject: string; message: string }
async function deliverNotification(checkKey: { monitorId: string; checkedAt: string }, notification: Notification): Promise<void> {
  await sns.send(new PublishCommand({ TopicArn: alertTopicArn, Subject: notification.subject, Message: notification.message, MessageAttributes: {
    userId: { DataType: 'String', StringValue: notification.userId },
    eventType: { DataType: 'String', StringValue: notification.eventType }
  } }));
  await db.send(new UpdateCommand({ TableName: checksTable, Key: checkKey, UpdateExpression: 'SET notificationSent = :sent, notificationSentAt = :sentAt', ExpressionAttributeValues: { ':sent': true, ':sentAt': new Date().toISOString() } }));
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  const failedGroups = new Set<string>();
  for (const record of event.Records) {
    const groupId = record.attributes.MessageGroupId || record.messageId;
    if (failedGroups.has(groupId)) { failures.push({ itemIdentifier: record.messageId }); continue; }
    try { await processJob(JSON.parse(record.body) as CheckJob); }
    catch (error) { failedGroups.add(groupId); console.error(JSON.stringify({ event: 'check_job_failed', messageId: record.messageId, error: error instanceof Error ? error.message : String(error) })); failures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures: failures };
}
