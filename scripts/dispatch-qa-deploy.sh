#!/usr/bin/env bash
set -euo pipefail
[[ "${QA_CD_ENABLED:-}" == true ]] || { printf 'QA CD is not provisioned/enabled\n' >&2; exit 2; }
[[ "$QA_DEPLOY_HOST" =~ ^[A-Za-z0-9.-]+$ && "$QA_DEPLOY_USER" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
[[ "$QA_DEPLOY_ROOT" =~ ^/[A-Za-z0-9/_-]+$ && "$QA_PORT" =~ ^[0-9]+$ ]] || exit 2
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
case "$QA_ENVIRONMENT" in
  qa-staging) service=pdf-reader-qa-staging.service ;;
  qa-production) service=pdf-reader-qa.service ;;
  *) exit 2 ;;
esac
[[ -n "$QA_DEPLOY_KEY" && -n "$QA_KNOWN_HOSTS" ]] || exit 2
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
chmod 700 "$temporary"
printf '%s\n' "$QA_DEPLOY_KEY" >"$temporary/key"
printf '%s\n' "$QA_KNOWN_HOSTS" >"$temporary/known_hosts"
chmod 600 "$temporary/key"
options=(-i "$temporary/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$temporary/known_hosts")
(cd artifacts && sha256sum --check ./*.sha256)
archives=(artifacts/*.tar.gz)
[[ "${#archives[@]}" == 1 ]] || exit 2
destination="$QA_DEPLOY_USER@$QA_DEPLOY_HOST"
remote="/tmp/qa-$SOURCE_SHA-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
scp "${options[@]}" "${archives[0]}" "$destination:$remote.tar.gz"
scp "${options[@]}" scripts/deploy-qa.sh "$destination:$remote.sh"
ssh "${options[@]}" "$destination" "QA_DEPLOY_ROOT=$QA_DEPLOY_ROOT QA_SERVICE_NAME=$service QA_HEALTH_URL=http://127.0.0.1:$QA_PORT/api/qa/health bash $remote.sh $remote.tar.gz $SOURCE_SHA"
ssh "${options[@]}" "$destination" "rm -f $remote.sh $remote.tar.gz"
