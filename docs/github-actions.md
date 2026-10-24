# GitHub Actions CI/CD

The `CI/CD` workflow validates every push and pull request with Node 22, a lockfile-based infrastructure install, JavaScript syntax checks, local API/domain tests, CDK tests, TypeScript checking, and CloudFormation synthesis. The synthesized cloud assembly is retained for seven days.

Deployment is continuous delivery with a manual release trigger: run **Actions → CI/CD → Run workflow**, choose `main`, and select `deploy`. The same run must pass validation before the `development` deployment job can start. Pull requests cannot deploy. Each deployment checks out the run's exact commit, synthesizes an account-specific assembly, prints its infrastructure diff, and deploys that assembly. Deployments serialize without interrupting an in-flight CloudFormation update.

## One-time configuration

1. Use the existing bootstrapped AWS account in `us-west-2`. This workflow updates `PulseApiMonitorDev`; it deliberately fails if the existing stack or scheduler cannot be read. Bootstrap and initial stack creation remain operator tasks.
2. Create a GitHub environment named `development`. Restrict deployment branches to `main`. Add required reviewers if your repository visibility and GitHub plan support them. The manual trigger itself does not create an approval requirement.
3. Configure the AWS IAM OIDC provider `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`. Create a dedicated deployment role using the following trust policy, replacing `ACCOUNT_ID`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {"StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:mohamed-adem/api-monitor:environment:development"
    }}
  }]
}
```

4. Grant the role CDK deployment permissions for the existing bootstrap configuration. For a standard `hnb659fds` bootstrap, the starting policy below allows assuming only the three required bootstrap roles, reading stack metadata, reading bootstrap version metadata, and inspecting the scheduler. Replace `ACCOUNT_ID`; confirm your actual bootstrap qualifier and role names. The bootstrap deployment and CloudFormation execution roles determine the ultimate resource permissions, so review those roles too.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::ACCOUNT_ID:role/cdk-hnb659fds-deploy-role-ACCOUNT_ID-us-west-2",
        "arn:aws:iam::ACCOUNT_ID:role/cdk-hnb659fds-file-publishing-role-ACCOUNT_ID-us-west-2",
        "arn:aws:iam::ACCOUNT_ID:role/cdk-hnb659fds-lookup-role-ACCOUNT_ID-us-west-2"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["cloudformation:DescribeStacks", "cloudformation:DescribeStackResource", "cloudformation:GetTemplate"],
      "Resource": "arn:aws:cloudformation:us-west-2:ACCOUNT_ID:stack/PulseApiMonitorDev/*"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:us-west-2:ACCOUNT_ID:parameter/cdk-bootstrap/hnb659fds/version"
    },
    {
      "Effect": "Allow",
      "Action": "scheduler:GetSchedule",
      "Resource": "arn:aws:scheduler:us-west-2:ACCOUNT_ID:schedule/default/*"
    }
  ]
}
```

5. Set the environment **variable** `AWS_DEPLOY_ROLE_ARN` to that role's ARN. No long-lived AWS access keys are needed.
6. Merge the workflow into the default branch, then run validation and a deployment. Configure `validate` as a required branch check in the repository ruleset. These repository and AWS settings are prerequisites; adding the workflow file does not configure them.

See the official [AWS OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) and [GitHub environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Verification and recovery

Before synthesis, the deployment reads the existing schedule's state and passes it through CDK's `schedulerState` context. A disabled schedule stays disabled. Direct local deployments retain the original enabled default; use `-c schedulerState=DISABLED` when preserving a disabled schedule locally.

After CloudFormation completes, the workflow checks the public CloudFront `/api/health` response, including the service name and status. This verifies public routing and API availability; it does not replace the authenticated lifecycle smoke test in `scripts/aws-smoke-test.sh`. Deployment outputs and templates are retained for fourteen days, with the commit and dashboard URL in the job summary.

CloudFormation retains its normal rollback behavior on a failed update. A failed post-deployment health check marks the run failed but does not automatically revert a successful infrastructure update. Inspect CloudFormation events and the job logs, then deploy a corrected commit or revert the application change through a pull request and run deployment again. Never cancel an active deployment merely to release a newer commit.

## Resume wording

After a successful GitHub-hosted deployment, a supported bullet is:

> Built a GitHub Actions CI/CD pipeline for an AWS serverless monitoring platform, automating API tests, infrastructure validation, CloudFormation synthesis, OIDC-authenticated deployments, and post-deployment health checks.

Until the AWS role and GitHub environment are configured and a real run succeeds, describe this as an implemented pipeline awaiting deployment integration. No deployment speed, availability, or coverage improvement has been measured.
