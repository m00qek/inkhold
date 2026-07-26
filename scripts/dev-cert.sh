#!/usr/bin/env bash
# Generate a self-signed EC cert/key for local HTTPS testing into ./certs.
# For development only; do not commit or deploy these.
set -euo pipefail
dir="${1:-certs}"
mkdir -p "$dir"
openssl ecparam -genkey -name prime256v1 -out "$dir/key.pem"
openssl req -new -x509 -key "$dir/key.pem" -out "$dir/cert.pem" -days 3650 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "wrote $dir/cert.pem and $dir/key.pem"
