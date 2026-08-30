import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { CheckJob, Monitor } from '../shared/model.js';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const tableName = process.env.MONITORS_TABLE!;
const queueUrl = process.env.CHECK_QUEUE_URL!;
const dueIndex = process.env.DUE_INDEX || 'DueIndex';

export async function handler(): Promise<{ queued: number }> {
  const now = Date.now();
  const result = await db.send(new QueryCommand({
    TableName: tableName,
    IndexName: dueIndex,
    KeyConditionExpression: 'schedulePartition = :active AND nextCheckAt <= :now',
    ExpressionAttributeValues: { ':active': 'ACTIVE', ':now': now },
    Limit: 50
  }));
  let queued = 0;
  for (const item of (result.Items || []) as Monitor[]) {
    const maintenance = item.maintenanceWindow;
    if (maintenance && now >= Date.parse(maintenance.startsAt) && now < Date.parse(maintenance.endsAt)) {
      await db.send(new UpdateCommand({
        TableName: tableName,
        Key: { userId: item.userId, monitorId: item.monitorId },
        UpdateExpression: 'SET #status = :maintenance, nextCheckAt = :next, updatedAt = :updatedAt',
        ConditionExpression: 'nextCheckAt = :previous AND enabled = :enabled',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':maintenance': 'MAINTENANCE', ':next': Math.min(Date.parse(maintenance.endsAt), now + item.intervalMinutes * 60_000), ':updatedAt': new Date().toISOString(), ':previous': item.nextCheckAt, ':enabled': true }
      }));
      continue;
    }
    const job: CheckJob = { jobId: randomUUID(), userId: item.userId, monitorId: item.monitorId, requestedAt: new Date().toISOString(), source: 'scheduled' };
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job), MessageGroupId: item.monitorId, MessageDeduplicationId: job.jobId }));
    await db.send(new UpdateCommand({
      TableName: tableName,
      Key: { userId: item.userId, monitorId: item.monitorId },
      UpdateExpression: 'SET nextCheckAt = :next, updatedAt = :updatedAt',
      ConditionExpression: 'nextCheckAt = :previous AND enabled = :enabled',
      ExpressionAttributeValues: { ':next': now + item.intervalMinutes * 60_000, ':updatedAt': new Date().toISOString(), ':previous': item.nextCheckAt, ':enabled': true }
    }));
    queued += 1;
  }
  console.log(JSON.stringify({ event: 'checks_dispatched', queued }));
  return { queued };
}
