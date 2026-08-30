import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';

interface ApiMonitorStackProps extends cdk.StackProps {
  frontendOrigin: string;
  budgetEmail?: string;
}

export class ApiMonitorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiMonitorStackProps) {
    super(scope, id, props);

    const monitors = new dynamodb.Table(this, 'Monitors', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'monitorId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    monitors.addGlobalSecondaryIndex({
      indexName: 'DueIndex',
      partitionKey: { name: 'schedulePartition', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'nextCheckAt', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const checks = new dynamodb.Table(this, 'Checks', {
      partitionKey: { name: 'monitorId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'checkedAt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const incidents = new dynamodb.Table(this, 'Incidents', {
      partitionKey: { name: 'monitorId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'incidentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    incidents.addGlobalSecondaryIndex({
      indexName: 'UserStatusIndex',
      partitionKey: { name: 'userStatus', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const statusPages = new dynamodb.Table(this, 'StatusPages', {
      partitionKey: { name: 'pageKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const alertPreferences = new dynamodb.Table(this, 'AlertPreferences', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const aggregates = new dynamodb.Table(this, 'Aggregates', {
      partitionKey: { name: 'monitorId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'bucketKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const deadLetterQueue = new sqs.Queue(this, 'CheckDeadLetterQueue', {
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const checkQueue = new sqs.Queue(this, 'CheckQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(90),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    // EventBridge Scheduler only accepts a standard SQS queue as its DLQ.
    // Keep this separate from the FIFO worker DLQ, which preserves per-monitor ordering.
    const schedulerDeadLetterQueue = new sqs.Queue(this, 'SchedulerDeadLetterQueue', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const alerts = new sns.Topic(this, 'IncidentAlerts', { displayName: 'Pulse incident alerts' });

    const userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 10, requireDigits: true, requireLowercase: true, requireUppercase: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true
    });

    const functionDefaults: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: true, sourceMap: true, target: 'node22', sourcesContent: false }
    };

    const apiHandler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      ...functionDefaults,
      entry: path.join(__dirname, '../src/functions/api.ts'),
      handler: 'handler',
      logGroup: new logs.LogGroup(this, 'ApiHandlerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      environment: {
        MONITORS_TABLE: monitors.tableName,
        CHECKS_TABLE: checks.tableName,
        INCIDENTS_TABLE: incidents.tableName,
        STATUS_PAGES_TABLE: statusPages.tableName,
        ALERT_PREFERENCES_TABLE: alertPreferences.tableName,
        AGGREGATES_TABLE: aggregates.tableName,
        ALERT_TOPIC_ARN: alerts.topicArn,
        CHECK_QUEUE_URL: checkQueue.queueUrl,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId
      }
    });
    monitors.grantReadWriteData(apiHandler);
    checks.grantReadWriteData(apiHandler);
    incidents.grantReadWriteData(apiHandler);
    statusPages.grantReadWriteData(apiHandler);
    alertPreferences.grantReadWriteData(apiHandler);
    aggregates.grantReadWriteData(apiHandler);
    apiHandler.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:TransactWriteItems'], resources: [statusPages.tableArn] }));
    checkQueue.grantSendMessages(apiHandler);
    apiHandler.addToRolePolicy(new iam.PolicyStatement({ actions: ['sns:Subscribe', 'sns:GetSubscriptionAttributes', 'sns:SetSubscriptionAttributes', 'sns:Unsubscribe'], resources: [alerts.topicArn, `${alerts.topicArn}:*`] }));

    const worker = new nodejs.NodejsFunction(this, 'CheckWorker', {
      ...functionDefaults,
      entry: path.join(__dirname, '../src/functions/worker.ts'),
      handler: 'handler',
      logGroup: new logs.LogGroup(this, 'CheckWorkerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      environment: { MONITORS_TABLE: monitors.tableName, CHECKS_TABLE: checks.tableName, INCIDENTS_TABLE: incidents.tableName, AGGREGATES_TABLE: aggregates.tableName, ALERT_TOPIC_ARN: alerts.topicArn, FAILURE_THRESHOLD: '2', CHECK_RETENTION_DAYS: '30' }
    });
    monitors.grantReadWriteData(worker);
    // The worker reads the deterministic check key before writing so SQS retries stay idempotent.
    checks.grantReadWriteData(worker);
    incidents.grantReadWriteData(worker);
    aggregates.grantReadWriteData(worker);
    alerts.grantPublish(worker);
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:TransactWriteItems'], resources: [monitors.tableArn, checks.tableArn, incidents.tableArn, aggregates.tableArn] }));
    worker.addEventSource(new sources.SqsEventSource(checkQueue, { batchSize: 5, reportBatchItemFailures: true }));

    const dispatcher = new nodejs.NodejsFunction(this, 'CheckDispatcher', {
      ...functionDefaults,
      entry: path.join(__dirname, '../src/functions/dispatcher.ts'),
      handler: 'handler',
      logGroup: new logs.LogGroup(this, 'CheckDispatcherLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      timeout: cdk.Duration.seconds(20),
      environment: { MONITORS_TABLE: monitors.tableName, CHECK_QUEUE_URL: checkQueue.queueUrl, DUE_INDEX: 'DueIndex' }
    });
    monitors.grantReadWriteData(dispatcher);
    checkQueue.grantSendMessages(dispatcher);

    const schedulerRole = new iam.Role(this, 'SchedulerRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    dispatcher.grantInvoke(schedulerRole);
    schedulerDeadLetterQueue.grantSendMessages(schedulerRole);
    new scheduler.CfnSchedule(this, 'MinuteSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'rate(1 minute)',
      state: 'ENABLED',
      target: { arn: dispatcher.functionArn, roleArn: schedulerRole.roleArn, deadLetterConfig: { arn: schedulerDeadLetterQueue.queueArn }, retryPolicy: { maximumEventAgeInSeconds: 60, maximumRetryAttempts: 2 } }
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'pulse-api-monitor-dev',
      corsPreflight: { allowOrigins: [props.frontendOrigin], allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PATCH, apigwv2.CorsHttpMethod.DELETE, apigwv2.CorsHttpMethod.OPTIONS], allowHeaders: ['authorization', 'content-type'], maxAge: cdk.Duration.hours(1) }
    });
    const integration = new integrations.HttpLambdaIntegration('ApiIntegration', apiHandler);
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('CognitoAuthorizer', `https://cognito-idp.${this.region}.${this.urlSuffix}/${userPool.userPoolId}`, { jwtAudience: [userPoolClient.userPoolClientId] });
    httpApi.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/api/config', methods: [apigwv2.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/api/health', methods: [apigwv2.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/status/{slug}', methods: [apigwv2.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/api/status/{slug}', methods: [apigwv2.HttpMethod.GET], integration });
    for (const route of [
      { path: '/monitors', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST] },
      { path: '/monitors/{monitorId}', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE] },
      { path: '/monitors/{monitorId}/check', methods: [apigwv2.HttpMethod.POST] },
      { path: '/monitors/{monitorId}/checks', methods: [apigwv2.HttpMethod.GET] },
      { path: '/monitors/{monitorId}/incidents', methods: [apigwv2.HttpMethod.GET] },
      { path: '/monitors/{monitorId}/incidents/{incidentId}', methods: [apigwv2.HttpMethod.PATCH] },
      { path: '/monitors/{monitorId}/analytics', methods: [apigwv2.HttpMethod.GET] },
      { path: '/incidents', methods: [apigwv2.HttpMethod.GET] },
      { path: '/alert-preferences', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE] },
      { path: '/status-page', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE] }
    ]) httpApi.addRoutes({ ...route, integration, authorizer: jwtAuthorizer });
    for (const route of [
      { path: '/api/monitors', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST] },
      { path: '/api/monitors/{monitorId}', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE] },
      { path: '/api/monitors/{monitorId}/check', methods: [apigwv2.HttpMethod.POST] },
      { path: '/api/monitors/{monitorId}/checks', methods: [apigwv2.HttpMethod.GET] },
      { path: '/api/monitors/{monitorId}/incidents', methods: [apigwv2.HttpMethod.GET] },
      { path: '/api/monitors/{monitorId}/incidents/{incidentId}', methods: [apigwv2.HttpMethod.PATCH] },
      { path: '/api/monitors/{monitorId}/analytics', methods: [apigwv2.HttpMethod.GET] },
      { path: '/api/incidents', methods: [apigwv2.HttpMethod.GET] },
      { path: '/api/alert-preferences', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE] },
      { path: '/api/status-page', methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE] }
    ]) httpApi.addRoutes({ ...route, integration, authorizer: jwtAuthorizer });

    const webBucket = new s3.Bucket(this, 'WebAssets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, preload: true, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true }
      }
    });
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true
      },
      additionalBehaviors: {
        'api/*': {
          origin: new origins.HttpOrigin(apiDomain, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true
        }
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100
    });
    new s3deploy.BucketDeployment(this, 'DeployWebAssets', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../public'))],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*']
    });

    new cloudwatch.Alarm(this, 'DeadLetterAlarm', { metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, alarmDescription: 'Pulse health-check jobs are failing repeatedly', treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING });
    new cloudwatch.Alarm(this, 'SchedulerDeadLetterAlarm', { metric: schedulerDeadLetterQueue.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, alarmDescription: 'Pulse scheduled dispatcher invocations are failing repeatedly', treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING });
    new cloudwatch.Alarm(this, 'WorkerErrorAlarm', { metric: worker.metricErrors({ period: cdk.Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1, alarmDescription: 'Pulse check worker reported an error', treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING });

    const dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', { dashboardName: 'pulse-api-monitor-dev' });
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({ title: 'Queue depth', metrics: [checkQueue.metricApproximateNumberOfMessagesVisible()], width: 8 }),
      new cloudwatch.SingleValueWidget({ title: 'Oldest queued job', metrics: [checkQueue.metricApproximateAgeOfOldestMessage()], width: 8 }),
      new cloudwatch.SingleValueWidget({ title: 'Worker errors', metrics: [worker.metricErrors({ period: cdk.Duration.minutes(5) })], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'p95 latency by monitor', left: [new cloudwatch.MathExpression({ expression: 'SEARCH(\'{Pulse/ApiMonitor,MonitorId} MetricName="Latency"\', \'p95\', 300)', usingMetrics: {}, period: cdk.Duration.minutes(5), label: 'p95 latency' })], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'Successful checks', left: [new cloudwatch.MathExpression({ expression: 'SEARCH(\'{Pulse/ApiMonitor,MonitorId} MetricName="Success"\', \'Sum\', 300)', usingMetrics: {}, period: cdk.Duration.minutes(5), label: 'successes' })], width: 12 })
    );

    if (props.budgetEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: { budgetName: 'pulse-api-monitor-dev', budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 5, unit: 'USD' } },
        notificationsWithSubscribers: [{ notification: { comparisonOperator: 'GREATER_THAN', notificationType: 'FORECASTED', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }] }]
      });
    }

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'AlertTopicArn', { value: alerts.topicArn });
    new cdk.CfnOutput(this, 'WebUrl', { value: `https://${distribution.distributionDomainName}` });
  }
}
