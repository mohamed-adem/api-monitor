#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiMonitorStack } from '../lib/api-monitor-stack.js';

const app = new cdk.App();
const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-west-2';

new ApiMonitorStack(app, 'PulseApiMonitorDev', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  description: 'Pulse API Monitor development infrastructure',
  frontendOrigin: app.node.tryGetContext('frontendOrigin') || 'http://localhost:3000',
  budgetEmail: app.node.tryGetContext('budgetEmail')
});
