#!/bin/sh
# Superviseur d'opencode : certificats/proxy, configuration par défaut,
# redémarrage à la demande du cockpit (fichier /control/restart-request).
set -eu

CONTROL_DIR="${COCKPIT_CONTROL_DIR:-/control}"
CONFIG_DIR="${HOME}/.config/opencode"
LOG_FILE="${CONTROL_DIR}/opencode.log"
PORT="${OPENCODE_PORT:-4096}"

log() {
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [superviseur] $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

mkdir -p "$CONTROL_DIR" "$CONFIG_DIR" "${HOME}/.cockpit"

if [ "${#OPENCODE_SERVER_PASSWORD}" -lt 16 ] 2>/dev/null || [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  log "ERREUR : OPENCODE_SERVER_PASSWORD absent ou trop court (16 caractères minimum). Relancez install.ps1."
  exit 1
fi

# --- Certificats d'entreprise ---------------------------------------------------
# Magasin système + certs/*.pem|*.crt montés en lecture seule : la vérification TLS reste active.
EXTRA="${HOME}/.cockpit/extra-ca.pem"
BUNDLE="${HOME}/.cockpit/ca-bundle.pem"
: > "$EXTRA"
count=0
for f in /certs/*.pem /certs/*.crt; do
  [ -f "$f" ] || continue
  if grep -q 'BEGIN CERTIFICATE' "$f"; then
    cat "$f" >> "$EXTRA"
    printf '\n' >> "$EXTRA"
    count=$((count + 1))
  fi
done
cat /etc/ssl/certs/ca-certificates.crt "$EXTRA" > "$BUNDLE"
export SSL_CERT_FILE="$BUNDLE" CURL_CA_BUNDLE="$BUNDLE" GIT_SSL_CAINFO="$BUNDLE" \
  NODE_EXTRA_CA_CERTS="$BUNDLE" npm_config_cafile="$BUNDLE"
printf '%s\n' "$count" > "$CONTROL_DIR/ca-files.count"
log "certificats d'entreprise chargés : $count fichier(s)"

case "${COCKPIT_TLS_INSECURE:-0}" in
  1|true|TRUE|yes)
    export NODE_TLS_REJECT_UNAUTHORIZED=0 GIT_SSL_NO_VERIFY=1 npm_config_strict_ssl=false
    log "ATTENTION : vérification TLS DÉSACTIVÉE (COCKPIT_TLS_INSECURE=1)"
    ;;
esac

# --- Proxy : le trafic interne ne doit jamais passer par le proxy -----------------
internal="localhost,127.0.0.1,::1,opencode,cockpit"
NO_PROXY="${NO_PROXY:+${NO_PROXY},}${internal}"
export NO_PROXY no_proxy="$NO_PROXY"
if [ -n "${HTTPS_PROXY:-}" ]; then export https_proxy="$HTTPS_PROXY"; fi
if [ -n "${HTTP_PROXY:-}" ]; then export http_proxy="$HTTP_PROXY"; fi
if [ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}" ]; then log "proxy sortant configuré"; fi

# --- Configuration par projet -------------------------------------------------------
# Désactivée par défaut : un dépôt pourrait livrer dans .opencode/ des plugins exécutés
# sans confirmation dès l'ouverture du projet. COCKPIT_PROJECT_CONFIG=1 pour l'autoriser.
if [ "${COCKPIT_PROJECT_CONFIG:-0}" != "1" ]; then
  export OPENCODE_DISABLE_PROJECT_CONFIG=1
  log "configuration par projet (.opencode/ des dépôts) désactivée"
else
  log "ATTENTION : configuration par projet autorisée (COCKPIT_PROJECT_CONFIG=1)"
fi

# --- Configuration par défaut (uniquement au premier démarrage) -------------------
if [ ! -f "$CONFIG_DIR/opencode.json" ] && [ ! -f "$CONFIG_DIR/opencode.jsonc" ] && [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp /usr/local/share/cockpit/opencode.default.jsonc "$CONFIG_DIR/opencode.jsonc"
  log "configuration par défaut installée ($CONFIG_DIR/opencode.jsonc)"
fi
mkdir -p "$CONFIG_DIR/agents" "$CONFIG_DIR/commands" "$CONFIG_DIR/skills"

# --- Supervision ------------------------------------------------------------------
child=0
stopping=0
on_term() {
  stopping=1
  if [ "$child" -ne 0 ]; then kill -TERM "$child" 2>/dev/null || true; fi
}
trap on_term TERM INT

stop_child() {
  kill -TERM "$child" 2>/dev/null || true
  i=0
  while kill -0 "$child" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 1; i=$((i + 1)); done
  kill -KILL "$child" 2>/dev/null || true
}

cd /workspace
while [ "$stopping" -eq 0 ]; do
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 5000000 ]; then mv -f "$LOG_FILE" "$LOG_FILE.1"; fi
  rm -f "$CONTROL_DIR/restart-request"
  log "démarrage d'opencode $(opencode --version 2>/dev/null || echo '?') sur le port $PORT"
  opencode serve --hostname 0.0.0.0 --port "$PORT" --print-logs --log-level INFO >> "$LOG_FILE" 2>&1 &
  child=$!
  date +%s > "$CONTROL_DIR/opencode.started"
  while kill -0 "$child" 2>/dev/null && [ "$stopping" -eq 0 ]; do
    if [ -f "$CONTROL_DIR/restart-request" ]; then
      log "redémarrage demandé par le cockpit"
      rm -f "$CONTROL_DIR/restart-request"
      stop_child
      break
    fi
    sleep 1
  done
  if [ "$stopping" -eq 1 ]; then stop_child; fi
  wait "$child" 2>/dev/null || true
  child=0
  if [ "$stopping" -eq 0 ]; then log "opencode s'est arrêté, relance dans 2 s"; sleep 2; fi
done
log "arrêt du superviseur"
