import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiMonitorStack } from '../lib/api-monitor-stack.js';

function makeTemplate(props: { budgetEmail?: string } = {}) {
  const app = new cdk.App();
  const stack = new ApiMonitorStack(app, 'TestStack', { env: { account: '111111111111', region: 'us-west-2' }, frontendOrigin: 'http://localhost:3000', ...props });
  return Template.fromStack(stack);
}

test('creates the queue-based scheduled check architecture', () => {
  const output = makeTemplate();
  output.resourceCountIs('AWS::DynamoDB::Table', 3);
  output.resourceCountIs('AWS::SQS::Queue', 3);
  output.resourceCountIs('AWS::Scheduler::Schedule', 1);
  output.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  output.resourceCountIs('AWS::Cognito::UserPool', 1);
  output.resourceCountIs('AWS::CloudFront::Distribution', 1);
  output.resourceCountIs('AWS::S3::Bucket', 1);
  output.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  output.hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
  output.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Architectures: ['arm64'] });
  output.hasResourceProperties('AWS::Cognito::UserPoolClient', { ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH']) });
  output.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(1 minute)', FlexibleTimeWindow: { Mode: 'OFF' } });
  output.hasResourceProperties('AWS::SQS::Queue', { FifoQueue: true });
  output.hasResourceProperties('AWS::SQS::Queue', Match.not(Match.objectLike({ FifoQueue: true })));
});

test('creates a five-dollar forecast budget only when an email is supplied', () => {
  makeTemplate().resourceCountIs('AWS::Budgets::Budget', 0);
  makeTemplate({ budgetEmail: 'owner@example.com' }).hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: 'USD' } }) });
});
