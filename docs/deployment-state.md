# Development deployment

Last verified: September 11, 2026

- Region: `us-west-2`
- Stack: `PulseApiMonitorDev`
- Web dashboard: <https://d1ir16za70xnod.cloudfront.net>
- CloudFormation: `UPDATE_COMPLETE`
- EventBridge Scheduler: enabled at one-minute cadence
- CloudWatch alarms: worker errors, worker dead-letter queue, and scheduler dead-letter queue all `OK`
- Synthetic data after verification: temporary Cognito user, monitor, check, and history records removed

The deployed flow was verified with a temporary synthetic user. The test authenticated through Cognito, created a monitor through CloudFront/API Gateway, queued a check in SQS, executed it in Lambda, validated a JSON assertion, wrote the result and two aggregate buckets to DynamoDB, and updated the monitor to `UP`. It also verified that alert preferences were account-isolated, an active maintenance window blocked manual checks, and a public status page could be read without authentication. Cleanup removed the page, monitor history, aggregate buckets, and temporary user.

The deployed browser UI was also verified after CloudFront invalidation. It serves Overview, Monitors, Check Runs, Incidents, Reliability, Status Page, Help Center, and Account views with browser-history navigation. Reliability compares recent p50/p95 latency, failure rate, and pass/fail state changes. Anonymous visitors are gated by Cognito before protected dashboard content renders, while published status links remain intentionally public.

The worker role grants read/write access to the Checks table because each job performs an idempotency read before its transactional write. This closes an earlier IAM gap that sent otherwise valid jobs to the worker dead-letter queue.

After the fix was deployed, 214 stale jobs were removed from the worker dead-letter queue rather than replayed as a misleading burst of outdated checks. One final job that arrived during the deployment window was also removed. The queue was verified empty, the effective worker policy was verified to include `dynamodb:GetItem`, and no new `check_job_failed` events appeared after the corrected policy became active.

Incident email is not active yet because the SNS topic has no confirmed email subscription. The AWS account already has a separate monthly cost budget; the stack-level optional budget was not created because no email context was supplied.
