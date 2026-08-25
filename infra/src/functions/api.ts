import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { CheckJob, Monitor } from '../shared/model.js';
import { validateMonitorInput } from '../shared/validation.js';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const sqs = new SQSClient({});
const monitorsTable = required('MONITORS_TABLE');
const checksTable = required('CHECKS_TABLE');
const incidentsTable = required('INCIDENTS_TABLE');
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

    if (routeKey === 'GET /incidents') {
      const query = (status: string) => db.send(new QueryCommand({ TableName: incidentsTable, IndexName: 'UserStatusIndex', KeyConditionExpression: 'userStatus = :status', ExpressionAttributeValues: { ':status': `${ownerId}#${status}` }, ScanIndexForward: false, Limit: 50 }));
      const [open, resolved] = await Promise.all([query('OPEN'), query('RESOLVED')]);
      const items = [...(open.Items || []), ...(resolved.Items || [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 100);
      return response(200, { items });
    }

    if (!monitorId) return response(404, { error: 'Route not found' });
    const monitorResult = await db.send(new GetCommand({ TableName: monitorsTable, Key: { userId: ownerId, monitorId } }));
    const monitor = monitorResult.Item as Monitor | undefined;
    if (!monitor) return response(404, { error: 'Monitor not found' });

    if (routeKey === 'GET /monitors/{monitorId}') return response(200, monitor);
    if (routeKey === 'PATCH /monitors/{monitorId}') {
      const body = parseBody(event);
      const input = validateMonitorInput({ ...monitor, ...body });
      const updated: Monitor = { ...monitor, ...input, enabled: body.enabled === undefined ? monitor.enabled : Boolean(body.enabled), schedulePartition: body.enabled === false ? undefined : 'ACTIVE', nextCheckAt: Date.now(), updatedAt: new Date().toISOString() };
      await db.send(new PutCommand({ TableName: monitorsTable, Item: updated, ConditionExpression: 'attribute_exists(monitorId)' }));
      return response(200, updated);
    }
    if (routeKey === 'DELETE /monitors/{monitorId}') {
      const [checks, incidents] = await Promise.all([
        db.send(new QueryCommand({ TableName: checksTable, KeyConditionExpression: 'monitorId = :monitorId', ExpressionAttributeValues: { ':monitorId': monitorId }, ProjectionExpression: 'monitorId, checkedAt' })),
        db.send(new QueryCommand({ TableName: incidentsTable, KeyConditionExpression: 'monitorId = :monitorId', ExpressionAttributeValues: { ':monitorId': monitorId }, ProjectionExpression: 'monitorId, incidentId' }))
      ]);
      await Promise.all([
        deleteItems(checksTable, (checks.Items || []).map(item => ({ monitorId: item.monitorId, checkedAt: item.checkedAt }))),
        deleteItems(incidentsTable, (incidents.Items || []).map(item => ({ monitorId: item.monitorId, incidentId: item.incidentId })))
      ]);
      await db.send(new DeleteCommand({ TableName: monitorsTable, Key: { userId: ownerId, monitorId }, ConditionExpression: 'attribute_exists(monitorId)' }));
      return { statusCode: 204 };
    }
    if (routeKey === 'POST /monitors/{monitorId}/check') {
      if (monitor.enabled === false) return response(409, { error: 'Resume this monitor before running a check' });
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
    return response(404, { error: 'Route not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    const isInputError = /required|valid|supported|between|private|JSON|assertion/i.test(message);
    console.error(JSON.stringify({ event: 'api_error', routeKey: event.routeKey, message }));
    return response(isInputError ? 400 : 500, { error: isInputError ? message : 'Internal server error' });
  }
}
