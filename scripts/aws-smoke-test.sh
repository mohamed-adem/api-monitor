#!/bin/bash
set -euo pipefail

STACK_NAME="${1:-PulseApiMonitorDev}"
for dependency in aws curl jq openssl; do command -v "$dependency" >/dev/null || { echo "Missing dependency: $dependency" >&2; exit 1; }; done

output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

WEB_URL=$(output WebUrl)
API_URL=$(output ApiUrl)
USER_POOL_ID=$(output UserPoolId)
CLIENT_ID=$(output UserPoolClientId)
EMAIL="pulse-smoke-$(date +%s)@example.com"
PASSWORD="Aa9!$(openssl rand -hex 12)"
MONITOR_ID=""
ACCESS_TOKEN=""
CHECKS_TABLE=$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id Checks74B2F3FB --query 'StackResourceDetail.PhysicalResourceId' --output text)
INCIDENTS_TABLE=$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id Incidents169D50D8 --query 'StackResourceDetail.PhysicalResourceId' --output text)

cleanup() {
  set +e
  if [[ -n "$MONITOR_ID" && -n "$ACCESS_TOKEN" ]]; then
    curl -sS -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" "$WEB_URL/api/monitors/$MONITOR_ID" >/dev/null
    aws dynamodb query --table-name "$CHECKS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --projection-expression checkedAt --query 'Items[].checkedAt.S' --output text | tr '\t' '\n' | while read -r checked_at; do
      [[ -n "$checked_at" ]] && aws dynamodb delete-item --table-name "$CHECKS_TABLE" --key "{\"monitorId\":{\"S\":\"$MONITOR_ID\"},\"checkedAt\":{\"S\":\"$checked_at\"}}" >/dev/null
    done
    aws dynamodb query --table-name "$INCIDENTS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --projection-expression incidentId --query 'Items[].incidentId.S' --output text | tr '\t' '\n' | while read -r incident_id; do
      [[ -n "$incident_id" ]] && aws dynamodb delete-item --table-name "$INCIDENTS_TABLE" --key "{\"monitorId\":{\"S\":\"$MONITOR_ID\"},\"incidentId\":{\"S\":\"$incident_id\"}}" >/dev/null
    done
  fi
  aws cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL" >/dev/null 2>&1
}
trap cleanup EXIT

aws cognito-idp admin-create-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL" --message-action SUPPRESS --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "$USER_POOL_ID" --username "$EMAIL" --password "$PASSWORD" --permanent
ACCESS_TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id "$CLIENT_ID" --auth-parameters USERNAME="$EMAIL",PASSWORD="$PASSWORD" --query 'AuthenticationResult.AccessToken' --output text)

CREATE_RESPONSE=$(curl -sS -X POST "$WEB_URL/api/monitors" -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' --data "{\"name\":\"Deployment smoke test\",\"url\":\"$API_URL/health\",\"method\":\"GET\",\"expectedStatus\":200,\"timeoutMs\":5000,\"intervalMinutes\":60,\"assertions\":[{\"type\":\"json_path_equals\",\"path\":\"$.status\",\"value\":\"ok\"}]}" )
MONITOR_ID=$(printf '%s' "$CREATE_RESPONSE" | jq -r '.monitorId // empty')
[[ -n "$MONITOR_ID" ]]

QUEUE_RESPONSE=$(curl -sS -X POST "$WEB_URL/api/monitors/$MONITOR_ID/check" -H "Authorization: Bearer $ACCESS_TOKEN")
[[ $(printf '%s' "$QUEUE_RESPONSE" | jq -r '.status') == "queued" ]]

CHECK_RESPONSE='{"items":[]}'
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  CHECK_RESPONSE=$(curl -sS "$WEB_URL/api/monitors/$MONITOR_ID/checks" -H "Authorization: Bearer $ACCESS_TOKEN")
  [[ $(printf '%s' "$CHECK_RESPONSE" | jq '.items | length') -gt 0 ]] && break
  sleep 2
done

[[ $(printf '%s' "$CHECK_RESPONSE" | jq -r '.items[0].ok') == "true" ]]
MONITOR_RESPONSE=$(curl -sS "$WEB_URL/api/monitors/$MONITOR_ID" -H "Authorization: Bearer $ACCESS_TOKEN")
[[ $(printf '%s' "$MONITOR_RESPONSE" | jq -r '.status') == "UP" ]]

DELETE_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" "$WEB_URL/api/monitors/$MONITOR_ID")
[[ "$DELETE_STATUS" == "204" ]]
CHECK_COUNT=$(aws dynamodb query --table-name "$CHECKS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --select COUNT --query Count --output text)
INCIDENT_COUNT=$(aws dynamodb query --table-name "$INCIDENTS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --select COUNT --query Count --output text)
[[ "$CHECK_COUNT" == "0" && "$INCIDENT_COUNT" == "0" ]]
MONITOR_ID=""

cleanup
trap - EXIT
printf 'authenticated=true\nmonitor_created=true\njob_queued=true\ncheck_recorded=true\ncheck_passed=true\nmonitor_status=UP\nmonitor_history_deleted=true\ncleanup=complete\n'
