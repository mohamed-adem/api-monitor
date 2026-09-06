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
STATUS_SLUG="pulse-smoke-$(date +%s)"
CHECKS_TABLE=$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id Checks74B2F3FB --query 'StackResourceDetail.PhysicalResourceId' --output text)
INCIDENTS_TABLE=$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id Incidents169D50D8 --query 'StackResourceDetail.PhysicalResourceId' --output text)
AGGREGATES_TABLE=$(aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id AggregatesDCEBC1D6 --query 'StackResourceDetail.PhysicalResourceId' --output text)

cleanup() {
  set +e
  if [[ -n "$MONITOR_ID" && -n "$ACCESS_TOKEN" ]]; then
    curl -sS -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" "$WEB_URL/api/status-page" >/dev/null
    curl -sS -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" "$WEB_URL/api/monitors/$MONITOR_ID" >/dev/null
    aws dynamodb query --table-name "$CHECKS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --projection-expression checkedAt --query 'Items[].checkedAt.S' --output text | tr '\t' '\n' | while read -r checked_at; do
      [[ -n "$checked_at" ]] && aws dynamodb delete-item --table-name "$CHECKS_TABLE" --key "{\"monitorId\":{\"S\":\"$MONITOR_ID\"},\"checkedAt\":{\"S\":\"$checked_at\"}}" >/dev/null
    done
    aws dynamodb query --table-name "$INCIDENTS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --projection-expression incidentId --query 'Items[].incidentId.S' --output text | tr '\t' '\n' | while read -r incident_id; do
      [[ -n "$incident_id" ]] && aws dynamodb delete-item --table-name "$INCIDENTS_TABLE" --key "{\"monitorId\":{\"S\":\"$MONITOR_ID\"},\"incidentId\":{\"S\":\"$incident_id\"}}" >/dev/null
    done
    aws dynamodb query --table-name "$AGGREGATES_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --projection-expression bucketKey --query 'Items[].bucketKey.S' --output text | tr '\t' '\n' | while read -r bucket_key; do
      [[ -n "$bucket_key" ]] && aws dynamodb delete-item --table-name "$AGGREGATES_TABLE" --key "{\"monitorId\":{\"S\":\"$MONITOR_ID\"},\"bucketKey\":{\"S\":\"$bucket_key\"}}" >/dev/null
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
ANALYTICS_RESPONSE=$(curl -sS "$WEB_URL/api/monitors/$MONITOR_ID/analytics?window=24h" -H "Authorization: Bearer $ACCESS_TOKEN")
[[ $(printf '%s' "$ANALYTICS_RESPONSE" | jq -r '.summary.totalChecks') == "1" ]]
ALERT_RESPONSE=$(curl -sS "$WEB_URL/api/alert-preferences" -H "Authorization: Bearer $ACCESS_TOKEN")
[[ $(printf '%s' "$ALERT_RESPONSE" | jq -r '.item') == "null" ]]
MAINTENANCE_START=$(date -u -v-1M '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || date -u -d '1 minute ago' '+%Y-%m-%dT%H:%M:%S.000Z')
MAINTENANCE_END=$(date -u -v+10M '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || date -u -d '10 minutes' '+%Y-%m-%dT%H:%M:%S.000Z')
curl -sS -X PATCH "$WEB_URL/api/monitors/$MONITOR_ID" -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' --data "{\"maintenanceWindow\":{\"startsAt\":\"$MAINTENANCE_START\",\"endsAt\":\"$MAINTENANCE_END\",\"reason\":\"Smoke test maintenance\"}}" >/dev/null
MAINTENANCE_CHECK=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$WEB_URL/api/monitors/$MONITOR_ID/check" -H "Authorization: Bearer $ACCESS_TOKEN")
[[ "$MAINTENANCE_CHECK" == "409" ]]
curl -sS -X PATCH "$WEB_URL/api/monitors/$MONITOR_ID" -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' --data '{"maintenanceWindow":null}' >/dev/null
curl -sS -X PATCH "$WEB_URL/api/monitors/$MONITOR_ID" -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' --data '{"expectedStatus":503}' >/dev/null
for expected_count in 2 3; do
  curl -sS -X POST "$WEB_URL/api/monitors/$MONITOR_ID/check" -H "Authorization: Bearer $ACCESS_TOKEN" >/dev/null
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    CURRENT_COUNT=$(curl -sS "$WEB_URL/api/monitors/$MONITOR_ID/checks" -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.items | length')
    [[ "$CURRENT_COUNT" -ge "$expected_count" ]] && break
    sleep 2
  done
done
INCIDENT_RESPONSE=$(curl -sS "$WEB_URL/api/monitors/$MONITOR_ID/incidents" -H "Authorization: Bearer $ACCESS_TOKEN")
INCIDENT_ID=$(printf '%s' "$INCIDENT_RESPONSE" | jq -r '.items[0].incidentId // empty')
[[ -n "$INCIDENT_ID" ]]
PUBLIC_UPDATE=$(curl -sS -X PATCH "$WEB_URL/api/monitors/$MONITOR_ID/incidents/$INCIDENT_ID" -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' --data '{"publicTitle":"Testing recovery communications","publicMessage":"This is a temporary deployment verification update."}')
[[ $(printf '%s' "$PUBLIC_UPDATE" | jq -r '.publicTitle') == "Testing recovery communications" ]]

STATUS_RESPONSE=$(curl -sS -X PUT "$WEB_URL/api/status-page" -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' --data "{\"name\":\"Deployment smoke status\",\"slug\":\"$STATUS_SLUG\",\"monitorIds\":[\"$MONITOR_ID\"],\"published\":true}")
[[ $(printf '%s' "$STATUS_RESPONSE" | jq -r '.slug') == "$STATUS_SLUG" ]]
PUBLIC_RESPONSE=$(curl -sS "$WEB_URL/api/status/$STATUS_SLUG")
[[ $(printf '%s' "$PUBLIC_RESPONSE" | jq -r '.monitors[0].monitorId') == "$MONITOR_ID" ]]
[[ $(printf '%s' "$PUBLIC_RESPONSE" | jq -r '.generatedAt // empty') != "" ]]
[[ $(printf '%s' "$PUBLIC_RESPONSE" | jq -r '.incidents[0].publicMessage') == "This is a temporary deployment verification update." ]]
[[ $(printf '%s' "$PUBLIC_RESPONSE" | jq -r '.incidents[0] | has("reason")') == "false" ]]
STATUS_DELETE=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" "$WEB_URL/api/status-page")
[[ "$STATUS_DELETE" == "204" ]]
PUBLIC_DELETE_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/api/status/$STATUS_SLUG")
[[ "$PUBLIC_DELETE_STATUS" == "404" ]]

DELETE_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" "$WEB_URL/api/monitors/$MONITOR_ID")
[[ "$DELETE_STATUS" == "204" ]]
CHECK_COUNT=$(aws dynamodb query --table-name "$CHECKS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --select COUNT --query Count --output text)
INCIDENT_COUNT=$(aws dynamodb query --table-name "$INCIDENTS_TABLE" --key-condition-expression 'monitorId = :id' --expression-attribute-values "{\":id\":{\"S\":\"$MONITOR_ID\"}}" --select COUNT --query Count --output text)
[[ "$CHECK_COUNT" == "0" && "$INCIDENT_COUNT" == "0" ]]
MONITOR_ID=""

cleanup
trap - EXIT
printf 'authenticated=true\nmonitor_created=true\njob_queued=true\ncheck_recorded=true\ncheck_passed=true\nmonitor_status=UP\naggregates_persisted=true\nalert_preferences_isolated=true\nmaintenance_suppression=true\nincident_lifecycle=true\npublic_incident_update=true\ninternal_reason_private=true\npublic_status_page=true\nstatus_page_cleanup=true\nmonitor_history_deleted=true\ncleanup=complete\n'
