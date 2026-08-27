#!/usr/bin/env bash
set -euo pipefail

command -v aws >/dev/null || { echo "AWS CLI is not installed" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js is not installed" >&2; exit 1; }

active_arn="$(aws sts get-caller-identity --query Arn --output text)"
active_region="$(aws configure get region)"

if [[ "$active_arn" == *":root" ]]; then
  echo "Refusing to continue with the AWS root user" >&2
  exit 1
fi
if [[ "$active_region" != "us-west-2" ]]; then
  echo "Expected region us-west-2, found ${active_region:-unset}" >&2
  exit 1
fi

echo "AWS identity: $active_arn"
echo "AWS region: $active_region"
npm test
npm --prefix infra test
npm run infra:build
npm run infra:synth >/dev/null
echo "Preflight passed. No AWS resources were created."
