import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetSubscriptionAttributesCommand, SetSubscriptionAttributesCommand, SNSClient, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import type { AlertPreference, CheckJob, Monitor, StatusPage } from '../shared/model.js';
import { validateAlertPreferenceInput, validateMonitorInput, validatePublicIncidentUpdate, validateStatusPageInput } from '../shared/validation.js';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const sqs = new SQSClient({});
const sns = new SNSClient({});
const monitorsTable = required('MONITORS_TABLE');
const checksTable = required('CHECKS_TABLE');
const incidentsTable = required('INCIDENTS_TABLE');
const statusPagesTable = required('STATUS_PAGES_TABLE');
const alertPreferencesTable = required('ALERT_PREFERENCES_TABLE');
const aggregatesTable = required('AGGREGATES_TABLE');
const alertTopicArn = required('ALERT_TOPIC_ARN');
const queueUrl = required('CHECK_QUEUE_URL');
const userPoolId = required('USER_POOL_ID');
const userPoolClientId = required('USER_POOL_CLIENT_ID');

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
function response(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 { return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) }; }
function userId(event: APIGatewayProxyEventV2WithJWTAuthorizer): string { const sub = event.requestContext.authorizer?.jwt?.claims?.sub; if (!sub) throw new Error('Missing authenticated user'); return String(sub); }
function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> { try { return event.body ? JSON.parse(event.body) : {}; } catch { throw new Error('Request body must be valid JSON'); } }
async function deleteItems(tableName: string, keys: Record<string, unknown>[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 25) {
    let pending = keys.slice(index, index + 25).map(Key => ({ DeleteRequest: { Key } }));
    do {
      const result = await db.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
      pending = (result.UnprocessedItems?.[tableName] || []).flatMap(item => item.DeleteRequest?.Key ? [{ DeleteRequest: { Key: item.DeleteRequest.Key } }] : []);
    } while (pending.length);
  }
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  const routeKey = event.routeKey.replace(/^([A-Z]+) \/api\//, '$1 /');
  try {
    if (routeKey === 'GET /health') return response(200, { status: 'ok', service: 'pulse-api', timestamp: new Date().toISOString() });
    if (routeKey === 'GET /config') return response(200, { mode: 'aws', region: process.env.AWS_REGION, userPoolId, userPoolClientId });
    if (routeKey === 'GET /status/{slug}') {
      const slug = String(event.pathParameters?.slug || '').toLowerCase();
      const result = await db.send(new GetCommand({ TableName: statusPagesTable, Key: { pageKey: `SLUG#${slug}` } }));
      const page = result.Item as (StatusPage & { ownerId: string }) | undefined;
      if (!page?.published) return response(404, { error: 'Status page not found' });
      const monitorResult = await db.send(new BatchGetCommand({ RequestItems: { [monitorsTable]: { Keys: page.monitorIds.map(monitorId => ({ userId: page.ownerId, monitorId })), ProjectionExpression: 'monitorId, #name, #status, enabled, lastCheckedAt, lastLatencyMs', ExpressionAttributeNames: { '#name': 'name', '#status': 'status' } } } }));
      const monitorItems = monitorResult.Responses?.[monitorsTable] || [];
      const monitors = page.monitorIds.map(id => monitorItems.find(item => item.monitorId === id)).filter(Boolean).map(item => ({ monitorId: item!.monitorId, name: item!.name, status: item!.enabled === false ? 'MAINTENANCE' : item!.status, lastCheckedAt: item!.lastCheckedAt, lastLatencyMs: item!.lastLatencyMs }));
      const queryIncidents = (status: string) => db.send(new QueryCommand({ TableName: incidentsTable, IndexName: 'UserStatusIndex', KeyConditionExpression: 'userStatus = :status', ExpressionAttributeValues: { ':status': `${page.ownerId}#${status}` }, ScanIndexForward: false, Limit: 25 }));
      const [openIncidentResult, resolvedIncidentResult] = await Promise.all([queryIncidents('OPEN'), queryIncidents('RESOLVED')]);
      const monitorIds = new Set(page.monitorIds);
      const incidents = [...(openIncidentResult.Items || []), ...(resolvedIncidentResult.Items || [])]
        .filter(item => monitorIds.has(String(item.monitorId)))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, 10)
        .map(item => ({ incidentId: item.incidentId, monitorId: item.monitorId, status: item.status, publicTitle: item.publicTitle || (item.status === 'OPEN' ? 'Service disruption detected' : 'Service restored'), publicMessage: item.publicMessage || (item.status === 'OPEN' ? 'We are investigating an interruption to this service.' : 'This service has recovered and is operating normally.'), publicUpdatedAt: item.publicUpdatedAt, startedAt: item.startedAt, resolvedAt: item.resolvedAt }));
      return response(200, { name: page.name, slug: page.slug, updatedAt: page.updatedAt, generatedAt: new Date().toISOString(), monitors, incidents });
    }
    const ownerId = userId(event);
    const monitorId = event.pathParameters?.monitorId;

    if (routeKey === 'GET /monitors') {
      const result = await db.send(new QueryCommand({ TableName: monitorsTable, KeyConditionExpression: 'userId = :userId', ExpressionAttributeValues: { ':userId': ownerId } }));
      return response(200, { items: result.Items || [] });
    }

    if (routeKey === 'POST /monitors') {
      const input = validateMonitorInput(parseBody(event));
      const now = new Date().toISOString();
      const monitor: Monitor = { userId: ownerId, monitorId: `mon_${randomUUID()}`, ...input, enabled: true, status: 'PENDING', failureStreak: 0, schedulePartition: 'ACTIVE', nextCheckAt: Date.now(), createdAt: now, updatedAt: now };
      await db.send(new PutCommand({ TableName: monitorsTable, Item: monitor, ConditionExpression: 'attribute_not_exists(monitorId)' }));
      return response(201, monitor);
    }

    if (routeKey === 'GET /status-page') {
      const result = await db.send(new GetCommand({ TableName: statusPagesTable, Key: { pageKey: `OWNER#${ownerId}` } }));
      if (!result.Item) return response(200, { item: null });
      const { pageKey: _pageKey, ownerId: _ownerId, ...item } = result.Item;
      return response(200, { item });
    }

    if (routeKey === 'PUT /status-page') {
      const input = validateStatusPageInput(parseBody(event));
      const monitorResult = await db.send(new BatchGetCommand({ RequestItems: { [monitorsTable]: { Keys: input.monitorIds.map(monitorId => ({ userId: ownerId, monitorId })), ProjectionExpression: 'monitorId' } } }));
      if ((monitorResult.Responses?.[monitorsTable] || []).length !== input.monitorIds.length) return response(400, { error: 'One or more selected monitors were not found' });
      const currentResult = await db.send(new GetCommand({ TableName: statusPagesTable, Key: { pageKey: `OWNER#${ownerId}` } }));
      const current = currentResult.Item as (StatusPage & { pageKey: string; ownerId: string }) | undefined;
      const now = new Date().toISOString();
      const page: StatusPage & { ownerId: string } = { ...input, ownerId, createdAt: current?.createdAt || now, updatedAt: now };
      const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        { Put: { TableName: statusPagesTable, Item: { pageKey: `OWNER#${ownerId}`, ...page } } },
        { Put: { TableName: statusPagesTable, Item: { pageKey: `SLUG#${page.slug}`, ...page }, ConditionExpression: 'attribute_not_exists(pageKey) OR ownerId = :ownerId', ExpressionAttributeValues: { ':ownerId': ownerId } } }
      ];
      if (current?.slug && current.slug !== page.slug) items.push({ Delete: { TableName: statusPagesTable, Key: { pageKey: `SLUG#${current.slug}` }, ConditionExpression: 'ownerId = :ownerId', ExpressionAttributeValues: { ':ownerId': ownerId } } });
      try { await db.send(new TransactWriteCommand({ TransactItems: items })); }
      catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') return response(409, { error: 'That public slug is already in use' }); throw error; }
      return response(200, page);
    }

    if (routeKey === 'DELETE /status-page') {
      const currentResult = await db.send(new GetCommand({ TableName: statusPagesTable, Key: { pageKey: `OWNER#${ownerId}` } }));
      const current = currentResult.Item as (StatusPage & { ownerId: string }) | undefined;
      if (!current) return { statusCode: 204 };
      await db.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: statusPagesTable, Key: { pageKey: `OWNER#${ownerId}` } } },
        { Delete: { TableName: statusPagesTable, Key: { pageKey: `SLUG#${current.slug}` }, ConditionExpression: 'ownerId = :ownerId', ExpressionAttributeValues: { ':ownerId': ownerId } } }
      ] }));
      return { statusCode: 204 };
    }

    if (routeKey === 'GET /incidents') {
      const query = (status: string) => db.send(new QueryCommand({ TableName: incidentsTable, IndexName: 'UserStatusIndex', KeyConditionExpression: 'userStatus = :status', ExpressionAttributeValues: { ':status': `${ownerId}#${status}` }, ScanIndexForward: false, Limit: 50 }));
      const [open, resolved] = await Promise.all([query('OPEN'), query('RESOLVED')]);
      const items = [...(open.Items || []), ...(resolved.Items || [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 100);
      return response(200, { items });
    }

    if (routeKey === 'GET /alert-preferences') {
      const result = await db.send(new GetCommand({ TableName: alertPreferencesTable, Key: { userId: ownerId } }));
      const item = result.Item as AlertPreference | undefined;
      if (!item) return response(200, { item: null });
      let status = item.status;
      if (item.subscriptionArn && !item.subscriptionArn.startsWith('PendingConfirmation')) {
        try {
          const attributes = await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: item.subscriptionArn }));
          status = attributes.Attributes?.PendingConfirmation === 'true' ? 'PENDING' : 'CONFIRMED';
          if (status !== item.status) await db.send(new UpdateCommand({ TableName: alertPreferencesTable, Key: { userId: ownerId }, UpdateExpression: 'SET #status = :status, updatedAt = :now', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':status': status, ':now': new Date().toISOString() } }));
        } catch { status = item.status; }
      }
      return response(200, { item: { ...item, status } });
    }

    if (routeKey === 'PUT /alert-preferences') {
      const input = validateAlertPreferenceInput(parseBody(event));
      const currentResult = await db.send(new GetCommand({ TableName: alertPreferencesTable, Key: { userId: ownerId } }));
      const current = currentResult.Item as AlertPreference | undefined;
      const filterPolicy = JSON.stringify({ userId: [ownerId], eventType: input.events });
      if (current?.status === 'PENDING' && (current.email !== input.email || JSON.stringify(current.events) !== JSON.stringify(input.events))) return response(409, { error: 'Confirm or remove the pending email subscription before changing it' });
      let subscriptionArn = current?.subscriptionArn;
      let status: AlertPreference['status'] = current?.status || 'PENDING';
      if (current && current.email === input.email && subscriptionArn && !subscriptionArn.startsWith('PendingConfirmation')) {
        await sns.send(new SetSubscriptionAttributesCommand({ SubscriptionArn: subscriptionArn, AttributeName: 'FilterPolicy', AttributeValue: filterPolicy }));
        await sns.send(new SetSubscriptionAttributesCommand({ SubscriptionArn: subscriptionArn, AttributeName: 'FilterPolicyScope', AttributeValue: 'MessageAttributes' }));
      } else if (!current) {
        const subscribed = await sns.send(new SubscribeCommand({ TopicArn: alertTopicArn, Protocol: 'email', Endpoint: input.email, ReturnSubscriptionArn: true, Attributes: { FilterPolicy: filterPolicy, FilterPolicyScope: 'MessageAttributes' } }));
        subscriptionArn = subscribed.SubscriptionArn || 'PendingConfirmation';
        status = 'PENDING';
      }
      const now = new Date().toISOString();
      const item: AlertPreference = { userId: ownerId, ...input, status, subscriptionArn: subscriptionArn || 'PendingConfirmation', createdAt: current?.createdAt || now, updatedAt: now };
      await db.send(new PutCommand({ TableName: alertPreferencesTable, Item: item }));
      return response(200, item);
    }

    if (routeKey === 'DELETE /alert-preferences') {
      const currentResult = await db.send(new GetCommand({ TableName: alertPreferencesTable, Key: { userId: ownerId } }));
      const current = currentResult.Item as AlertPreference | undefined;
      if (current?.subscriptionArn && !current.subscriptionArn.startsWith('PendingConfirmation')) {
        try { await sns.send(new UnsubscribeCommand({ SubscriptionArn: current.subscriptionArn })); } catch (error) { if (!(error instanceof Error && /not.?found|invalid/i.test(error.message))) throw error; }
      }
      await db.send(new DeleteCommand({ TableName: alertPreferencesTable, Key: { userId: ownerId } }));
      return { statusCode: 204 };
    }

    if (!monitorId) return response(404, { error: 'Route not found' });
    const monitorResult = await db.send(new GetCommand({ TableName: monitorsTable, Key: { userId: ownerId, monitorId } }));
    const monitor = monitorResult.Item as Monitor | undefined;
    if (!monitor) return response(404, { error: 'Monitor not found' });

    if (routeKey === 'GET /monitors/{monitorId}') return response(200, monitor);
    if (routeKey === 'PATCH /monitors/{monitorId}') {
      const body = parseBody(event);
      const input = validateMonitorInput({ ...monitor, ...body });
      const enabled = body.enabled === undefined ? monitor.enabled : Boolean(body.enabled);
      const inMaintenance = enabled && input.maintenanceWindow && Date.now() >= Date.parse(input.maintenanceWindow.startsAt) && Date.now() < Date.parse(input.maintenanceWindow.endsAt);
      const updated: Monitor = { ...monitor, ...input, enabled, status: inMaintenance ? 'MAINTENANCE' : monitor.status === 'MAINTENANCE' ? 'PENDING' : monitor.status, schedulePartition: enabled ? 'ACTIVE' : undefined, nextCheckAt: inMaintenance ? Date.parse(input.maintenanceWindow!.endsAt) : Date.now(), updatedAt: new Date().toISOString() };
      await db.send(new PutCommand({ TableName: monitorsTable, Item: updated, ConditionExpression: 'attribute_exists(monitorId)' }));
      return response(200, updated);
    }
    if (routeKey === 'DELETE /monitors/{monitorId}') {
      const [checks, incidents, aggregates] = await Promise.all([
        db.send(new QueryCommand({ TableName: checksTable, KeyConditionExpression: 'monitorId = :monitorId', ExpressionAttributeValues: { ':monitorId': monitorId }, ProjectionExpression: 'monitorId, checkedAt' })),
        db.send(new QueryCommand({ TableName: incidentsTable, KeyConditionExpression: 'monitorId = :monitorId', ExpressionAttributeValues: { ':monitorId': monitorId }, ProjectionExpression: 'monitorId, incidentId' })),
        db.send(new QueryCommand({ TableName: aggregatesTable, KeyConditionExpression: 'monitorId = :monitorId', ExpressionAttributeValues: { ':monitorId': monitorId }, ProjectionExpression: 'monitorId, bucketKey' }))
      ]);
      await Promise.all([
        deleteItems(checksTable, (checks.Items || []).map(item => ({ monitorId: item.monitorId, checkedAt: item.checkedAt }))),
        deleteItems(incidentsTable, (incidents.Items || []).map(item => ({ monitorId: item.monitorId, incidentId: item.incidentId }))),
        deleteItems(aggregatesTable, (aggregates.Items || []).map(item => ({ monitorId: item.monitorId, bucketKey: item.bucketKey })))
      ]);
      await db.send(new DeleteCommand({ TableName: monitorsTable, Key: { userId: ownerId, monitorId }, ConditionExpression: 'attribute_exists(monitorId)' }));
      return { statusCode: 204 };
    }
    if (routeKey === 'POST /monitors/{monitorId}/check') {
      if (monitor.enabled === false) return response(409, { error: 'Resume this monitor before running a check' });
      if (monitor.maintenanceWindow && Date.now() >= Date.parse(monitor.maintenanceWindow.startsAt) && Date.now() < Date.parse(monitor.maintenanceWindow.endsAt)) return response(409, { error: 'This monitor is in a scheduled maintenance window' });
      const job: CheckJob = { jobId: randomUUID(), userId: ownerId, monitorId, requestedAt: new Date().toISOString(), source: 'manual' };
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job), MessageGroupId: monitorId, MessageDeduplicationId: job.jobId }));
      return response(202, { jobId: job.jobId, status: 'queued' });
    }
    if (routeKey === 'GET /monitors/{monitorId}/checks') {
      const result = await db.send(new QueryCommand({ TableName: checksTable, KeyConditionExpression: 'monitorId = :monitorId', ExpressionAttributeValues: { ':monitorId': monitorId }, ScanIndexForward: false, Limit: 100 }));
      return response(200, { items: result.Items || [] });
    }
    if (routeKey === 'GET /monitors/{monitorId}/incidents') {
      const result = await db.send(new QueryCommand({ TableName: incidentsTable, KeyConditionExpression: 'monitorId = :monitorId', ExpressionAttributeValues: { ':monitorId': monitorId }, ScanIndexForward: false, Limit: 50 }));
      return response(200, { items: result.Items || [] });
    }
    if (routeKey === 'PATCH /monitors/{monitorId}/incidents/{incidentId}') {
      const incidentId = String(event.pathParameters?.incidentId || '');
      if (!incidentId) return response(400, { error: 'Incident ID is required' });
      const input = validatePublicIncidentUpdate(parseBody(event));
      const now = new Date().toISOString();
      const result = await db.send(new UpdateCommand({ TableName: incidentsTable, Key: { monitorId, incidentId }, UpdateExpression: 'SET publicTitle = :title, publicMessage = :message, publicUpdatedAt = :now', ConditionExpression: 'attribute_exists(incidentId) AND userId = :userId', ExpressionAttributeValues: { ':title': input.publicTitle, ':message': input.publicMessage, ':now': now, ':userId': ownerId }, ReturnValues: 'ALL_NEW' }));
      return response(200, result.Attributes);
    }
    if (routeKey === 'GET /monitors/{monitorId}/analytics') {
      const window = event.queryStringParameters?.window || '24h';
      if (!['24h', '7d', '30d'].includes(window)) return response(400, { error: 'Analytics window must be 24h, 7d, or 30d' });
      const hourly = window === '24h';
      const start = new Date(Date.now() - (window === '24h' ? 24 : window === '7d' ? 7 * 24 : 30 * 24) * 60 * 60 * 1000);
      const startKey = hourly ? `HOUR#${new Date(start.setUTCMinutes(0, 0, 0)).toISOString()}` : `DAY#${start.toISOString().slice(0, 10)}`;
      const endKey = hourly ? `HOUR#${new Date().toISOString()}` : `DAY#${new Date().toISOString().slice(0, 10)}`;
      const result = await db.send(new QueryCommand({ TableName: aggregatesTable, KeyConditionExpression: 'monitorId = :monitorId AND bucketKey BETWEEN :start AND :end', ExpressionAttributeValues: { ':monitorId': monitorId, ':start': startKey, ':end': endKey }, ScanIndexForward: true }));
      const points = (result.Items || []).map(item => ({ bucketStart: item.bucketStart, totalChecks: item.totalChecks || 0, successCount: item.successCount || 0, failureCount: item.failureCount || 0, averageLatencyMs: item.totalChecks ? Math.round(item.latencySumMs / item.totalChecks) : 0 }));
      const summary = points.reduce((acc, point) => ({ totalChecks: acc.totalChecks + point.totalChecks, successCount: acc.successCount + point.successCount, failureCount: acc.failureCount + point.failureCount, latencySumMs: acc.latencySumMs + point.averageLatencyMs * point.totalChecks }), { totalChecks: 0, successCount: 0, failureCount: 0, latencySumMs: 0 });
      return response(200, { window, points, summary: { totalChecks: summary.totalChecks, failures: summary.failureCount, uptime: summary.totalChecks ? summary.successCount / summary.totalChecks * 100 : null, averageLatencyMs: summary.totalChecks ? Math.round(summary.latencySumMs / summary.totalChecks) : null } });
    }
    return response(404, { error: 'Route not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    const isInputError = /required|valid|supported|between|private|JSON|assertion/i.test(message);
    console.error(JSON.stringify({ event: 'api_error', routeKey: event.routeKey, message }));
    return response(isInputError ? 400 : 500, { error: isInputError ? message : 'Internal server error' });
  }
}
