#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-pdf-translate-reader}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env.local}"
PORT="${PORT:-8787}"
HTTPS_MODE="${HTTPS_MODE:-edge}"
WEB_ROOT="${WEB_ROOT:-/var/www/${APP_NAME}}"
SERVER_NAME="${SERVER_NAME:-_}"
PUBLIC_PORT="${PUBLIC_PORT:-}"
RUN_USER="${RUN_USER:-$(id -un)}"
RUN_GROUP="${RUN_GROUP:-$(id -gn)}"
SERVICE_NAME="${APP_NAME}.service"
SYSTEMD_SERVICE="/etc/systemd/system/${SERVICE_NAME}"
NGINX_CONF="/etc/nginx/conf.d/${APP_NAME}.conf"
HTTP_REDIRECT_PORT="${HTTP_REDIRECT_PORT:-80}"
SSL_CERT_PATH="${SSL_CERT_PATH:-}"
SSL_KEY_PATH="${SSL_KEY_PATH:-}"
CLIENT_MAX_BODY_SIZE="${CLIENT_MAX_BODY_SIZE:-120m}"

case "$HTTPS_MODE" in
  edge)
    WEB_PORT="${WEB_PORT:-80}"
    PUBLIC_SCHEME="${PUBLIC_SCHEME:-https}"
    ;;
  local)
    WEB_PORT="${WEB_PORT:-443}"
    PUBLIC_SCHEME="${PUBLIC_SCHEME:-https}"
    ;;
  off)
    WEB_PORT="${WEB_PORT:-80}"
    PUBLIC_SCHEME="${PUBLIC_SCHEME:-http}"
    ;;
  *)
    WEB_PORT="${WEB_PORT:-80}"
    PUBLIC_SCHEME="${PUBLIC_SCHEME:-https}"
    ;;
esac

log() {
  printf '\n[%s] %s\n' "$APP_NAME" "$1"
}

die() {
  printf '\n[%s] ERROR: %s\n' "$APP_NAME" "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

write_nginx_locations() {
  cat <<EOF
  root ${WEB_ROOT};
  index index.html;

  location /api/ {
    client_max_body_size ${CLIENT_MAX_BODY_SIZE};
    proxy_pass http://127.0.0.1:${PORT}/api/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 120s;
  }

  location ~* \\.mjs\$ {
    default_type application/javascript;
    try_files \$uri =404;
  }

  location / {
    try_files \$uri \$uri/ /index.html;
  }
EOF
}

format_public_url() {
  local primary_server_name="$1"
  local port_suffix=""

  if [[ -n "$PUBLIC_PORT" ]]; then
    port_suffix=":${PUBLIC_PORT}"
  elif [[ "$PUBLIC_SCHEME" == "http" && "$WEB_PORT" != "80" ]]; then
    port_suffix=":${WEB_PORT}"
  elif [[ "$PUBLIC_SCHEME" == "https" && "$WEB_PORT" != "443" && "$HTTPS_MODE" == "local" ]]; then
    port_suffix=":${WEB_PORT}"
  fi

  printf '%s://%s%s\n' "$PUBLIC_SCHEME" "$primary_server_name" "$port_suffix"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  die "This deployment script is intended for Linux servers."
fi

case "$HTTPS_MODE" in
  edge | local | off) ;;
  *) die "HTTPS_MODE must be one of: edge, local, off." ;;
esac

if [[ "$APP_DIR" == *" "* ]]; then
  die "APP_DIR contains spaces, which this systemd/nginx script does not support: ${APP_DIR}"
fi

require_command node
require_command npm
require_command systemctl

NODE_BIN="${NODE_BIN:-$(command -v node)}"
NGINX_BIN="${NGINX_BIN:-$(command -v nginx || true)}"

if [[ -z "$NGINX_BIN" && -x "/usr/sbin/nginx" ]]; then
  NGINX_BIN="/usr/sbin/nginx"
fi

if [[ -z "$NGINX_BIN" ]]; then
  die "Missing command: nginx"
fi

if [[ "$EUID" -eq 0 ]]; then
  SUDO=()
else
  require_command sudo

  if [[ ! -t 0 ]] && ! sudo -n true >/dev/null 2>&1; then
    die "This script needs sudo to write ${WEB_ROOT}, ${SYSTEMD_SERVICE}, and ${NGINX_CONF}. Run it from an interactive terminal with sudo access, or run sudo -v first."
  fi

  SUDO=(sudo)
fi

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f ".env.local.example" ]]; then
    cp ".env.local.example" "$ENV_FILE"
    die "Created ${ENV_FILE}. Edit it and set DEEPSEEK_API_KEY, then rerun this script."
  fi

  die "Missing ${ENV_FILE}. Create it and set DEEPSEEK_API_KEY."
fi

if ! grep -Eq '^DEEPSEEK_API_KEY=.+[^[:space:]]' "$ENV_FILE"; then
  die "${ENV_FILE} must contain DEEPSEEK_API_KEY."
fi

if grep -Eq '^DEEPSEEK_API_KEY=replace_with_your_deepseek_api_key' "$ENV_FILE"; then
  die "${ENV_FILE} still contains the placeholder DEEPSEEK_API_KEY."
fi

if [[ "$HTTPS_MODE" == "local" ]]; then
  if [[ -z "$SSL_CERT_PATH" || -z "$SSL_KEY_PATH" ]]; then
    die "HTTPS_MODE=local requires SSL_CERT_PATH and SSL_KEY_PATH. Use HTTPS_MODE=edge for Sakura FRP or another HTTPS reverse proxy."
  fi

  [[ -f "$SSL_CERT_PATH" ]] || die "SSL_CERT_PATH does not exist: ${SSL_CERT_PATH}"
  [[ -f "$SSL_KEY_PATH" ]] || die "SSL_KEY_PATH does not exist: ${SSL_KEY_PATH}"
fi

log "Installing npm dependencies"
npm ci

log "Building frontend"
npm run build

log "Publishing frontend to ${WEB_ROOT}"
"${SUDO[@]}" install -d -m 0755 "$WEB_ROOT"
"${SUDO[@]}" cp -R "${APP_DIR}/dist/." "$WEB_ROOT/"
"${SUDO[@]}" find "$WEB_ROOT" -type d -exec chmod 0755 {} +
"${SUDO[@]}" find "$WEB_ROOT" -type f -exec chmod 0644 {} +

tmp_service="$(mktemp)"
tmp_nginx="$(mktemp)"
trap 'rm -f "$tmp_service" "$tmp_nginx"' EXIT

cat >"$tmp_service" <<EOF
[Unit]
Description=PDF Translate Reader API proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=${NODE_BIN} ${APP_DIR}/server/index.mjs
Restart=always
RestartSec=3
User=${RUN_USER}
Group=${RUN_GROUP}

[Install]
WantedBy=multi-user.target
EOF

if [[ "$HTTPS_MODE" == "local" ]]; then
  cat >"$tmp_nginx" <<EOF
server {
  listen ${HTTP_REDIRECT_PORT};
  server_name ${SERVER_NAME};

  return 301 https://\$host\$request_uri;
}

server {
  listen ${WEB_PORT} ssl http2;
  server_name ${SERVER_NAME};

  ssl_certificate ${SSL_CERT_PATH};
  ssl_certificate_key ${SSL_KEY_PATH};
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
EOF

  write_nginx_locations >>"$tmp_nginx"

  cat >>"$tmp_nginx" <<EOF
}
EOF
else
  cat >"$tmp_nginx" <<EOF
server {
  listen ${WEB_PORT};
  server_name ${SERVER_NAME};
EOF

  write_nginx_locations >>"$tmp_nginx"

  cat >>"$tmp_nginx" <<EOF
}
EOF
fi

log "Installing systemd service: ${SYSTEMD_SERVICE}"
"${SUDO[@]}" cp "$tmp_service" "$SYSTEMD_SERVICE"
"${SUDO[@]}" chmod 0644 "$SYSTEMD_SERVICE"
"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable "$SERVICE_NAME"
"${SUDO[@]}" systemctl restart "$SERVICE_NAME"

log "Installing nginx site: ${NGINX_CONF}"
"${SUDO[@]}" mkdir -p "$(dirname "$NGINX_CONF")"
"${SUDO[@]}" cp "$tmp_nginx" "$NGINX_CONF"
"${SUDO[@]}" chmod 0644 "$NGINX_CONF"
"${SUDO[@]}" "$NGINX_BIN" -t
"${SUDO[@]}" systemctl enable nginx

if "${SUDO[@]}" systemctl is-active --quiet nginx; then
  "${SUDO[@]}" systemctl reload nginx
else
  "${SUDO[@]}" systemctl start nginx
fi

if command -v curl >/dev/null 2>&1; then
  log "Checking API health"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
      break
    fi
    sleep 1
  done

  curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null \
    || die "API health check failed. Inspect with: sudo systemctl status ${SERVICE_NAME}"
fi

log "Deployment complete"
read -r PRIMARY_SERVER_NAME _ <<<"$SERVER_NAME"
printf 'Frontend: %s\n' "$(format_public_url "$PRIMARY_SERVER_NAME")"
printf 'API health: http://127.0.0.1:%s/api/health\n' "$PORT"
printf 'Service logs: sudo journalctl -u %s -f\n' "$SERVICE_NAME"
