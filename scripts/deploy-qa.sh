#!/usr/bin/env bash
set -euo pipefail

# This deployer requires an already provisioned, dedicated QA service. It never
# publishes dist/, writes nginx config, migrates a database, or restarts the app.
artifact="${1:?Usage: deploy-qa.sh ARCHIVE EXPECTED_SHA}"
expected_sha="${2:?Expected source SHA is required}"
qa_root="${QA_DEPLOY_ROOT:?QA_DEPLOY_ROOT is required}"
qa_service="${QA_SERVICE_NAME:?QA_SERVICE_NAME is required}"
health_url="${QA_HEALTH_URL:?QA_HEALTH_URL is required}"
case "$qa_service" in pdf-reader-qa.service|pdf-reader-qa-staging.service) ;; *) exit 2 ;; esac
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$qa_root" == /* && "$qa_root" != / && -f "$qa_root/.qa-deploy-root" ]] || exit 2
[[ "$(cat "$qa_root/.qa-deploy-root")" == "$qa_service" ]] || exit 2
[[ "$health_url" =~ ^http://127\.0\.0\.1:[0-9]+/api/qa/health$ ]] || exit 2
[[ ! -e "$qa_root/current" || -L "$qa_root/current" ]] || exit 2

# Reject traversal and links in the release before extraction.
if tar -tzf "$artifact" | awk '/(^\/|(^|\/)\.\.($|\/))/ { bad=1 } END { exit !bad }'; then exit 2; fi
if tar -tvzf "$artifact" | awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { bad=1 } END { exit !bad }'; then exit 2; fi
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
tar -xzf "$artifact" -C "$temp" --no-same-owner
node --input-type=module - "$temp" "$expected_sha" <<'JS'
import { readFileSync } from 'node:fs';
const [root, sha] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(`${root}/qa-release.json`));
const pkg = JSON.parse(readFileSync(`${root}/server/qa/package.json`));
if (manifest.service !== 'pdf-reader-qa' || manifest.sha !== sha || manifest.version !== pkg.version) process.exit(2);
if (process.env.QA_SERVICE_NAME === 'pdf-reader-qa.service' && pkg.version.includes('-')) process.exit(2);
JS
if [[ "${QA_DEPLOY_DRY_RUN:-0}" == 1 ]]; then
  printf 'Validated QA release %s for %s\n' "$expected_sha" "$qa_service"
  exit 0
fi

exec 9>"$qa_root/deploy.lock"
flock -n 9 || { printf 'Another QA deployment is running\n' >&2; exit 1; }
release_dir="$qa_root/releases/$expected_sha"
mkdir -p "$qa_root/releases"
[[ ! -e "$release_dir" ]] || { printf 'Release already exists; use the documented rollback procedure\n' >&2; exit 1; }
mv "$temp" "$release_dir"
temp="$(mktemp -d)"
(cd "$release_dir" && npm ci --omit=dev --ignore-scripts)
previous="$(readlink "$qa_root/current" || true)"
switch_release() {
  ln -s "$1" "$qa_root/.next"
  mv -Tf "$qa_root/.next" "$qa_root/current"
}
rollback() {
  if [[ -n "$previous" ]]; then
    switch_release "$previous"
    sudo -n systemctl restart "$qa_service"
  else
    rm -f "$qa_root/current"
    sudo -n systemctl stop "$qa_service"
  fi
}
switch_release "$release_dir"
if ! sudo -n systemctl restart "$qa_service"; then rollback; exit 1; fi
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 "$health_url" >"$temp/health.json" &&
    node --input-type=module - "$temp/health.json" "$expected_sha" <<'JS'
import { readFileSync } from 'node:fs';
const [path, sha] = process.argv.slice(2);
const value = JSON.parse(readFileSync(path));
if (value.status !== 'ok' || value.service !== 'pdf-reader-qa' || value.sha !== sha) process.exit(1);
JS
  then
    printf 'QA deployed: %s\n' "$expected_sha"
    exit 0
  fi
  sleep 1
done
rollback
printf 'QA health verification failed; restored previous release\n' >&2
exit 1
