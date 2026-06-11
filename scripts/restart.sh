#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

git pull

HTTPS_MODE=local \
SERVER_NAME="pdf-translate-reader.xyz pdf.fenglin.pro" \
SSL_CERT_PATH=/etc/letsencrypt/live/pdf-translate-reader.xyz/fullchain.pem \
SSL_KEY_PATH=/etc/letsencrypt/live/pdf-translate-reader.xyz/privkey.pem \
bash scripts/deploy-linux-nginx.sh