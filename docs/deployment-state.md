# Development deployment

Last verified: September 11, 2026

- Region: `us-west-2`
- Stack: `PulseApiMonitorDev`
- Web dashboard: <https://d1ir16za70xnod.cloudfront.net>
- CloudFormation: `UPDATE_COMPLETE`
- EventBridge Scheduler: enabled at one-minute cadence
- CloudWatch alarms: worker errors, worker dead-letter queue, and scheduler dead-letter queue all `OK`
- Synthetic data after verification: temporary Cognito user, monitor, check, and history records removed

The deployed flow was verified with a temporary synthetic user. The test authenticated through Cognito, created a monitor through CloudFront/API Gateway, queued a check in SQS, executed it in Lambda, validated a JSON assertion, wrote the result to DynamoDB, and updated the monitor to `UP`. It then exercised cascade deletion and verified that associated check and incident records were gone before removing the temporary user.

The deployed browser UI was also verified after CloudFront invalidation. It serves Overview, Monitors, Check Runs, Incidents, Help Center, and Account views with browser-history navigation, while anonymous visitors are gated by Cognito sign-in before the dashboard renders.

Incident email is not active yet because the SNS topic has no confirmed email subscription. The AWS account already has a separate monthly cost budget; the stack-level optional budget was not created because no email context was supplied.
