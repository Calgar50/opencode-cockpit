#!/bin/sh
# Santé d'opencode, sans passer par un éventuel proxy.
exec curl -fsS -m 5 --noproxy '*' -o /dev/null \
  -u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD}" \
  "http://127.0.0.1:${OPENCODE_PORT:-4096}/global/health"
