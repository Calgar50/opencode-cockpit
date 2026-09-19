#!/usr/bin/env bash
# Test de fumee de l'image app (1.0.5) : HTTPS local par defaut, mode HTTP explicite, confinement de la cle privee.
#
#   bash .github/ci/https-smoke.sh <image>
#
# Reglages (pour executer le test a cote d'un cockpit reel, sans jamais le toucher) :
#   SMOKE_PREFIX       prefixe des conteneurs, volumes, images et projets crees (defaut : cockpit-smoke)
#   SMOKE_PORT_HTTPS   port publie du mode HTTPS (defaut : 17777)
#   SMOKE_PORT_HTTP    port publie du mode HTTP  (defaut : 17778)
#
# Regles :
# - toutes les ressources Docker creees portent le label cockpit-smoke=<prefixe> ; le nettoyage par trap ne touche rien
#   d'autre : aucun conteneur, volume ou image sans ce label n'est supprime ;
# - les jetons sont tires au hasard a chaque execution et ne sont jamais affiches ; aucun defi, aucune preuve, aucune
#   cle et aucun condense de cle ne sont ecrits sur la sortie ;
# - aucune sortie de « docker compose config » n'est affichee : elle contient le jeton.
set -euo pipefail

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: https-smoke.sh <image>" >&2
  exit 2
fi

PREFIX="${SMOKE_PREFIX:-cockpit-smoke}"
PORT_HTTPS="${SMOKE_PORT_HTTPS:-17777}"
PORT_HTTP="${SMOKE_PORT_HTTP:-17778}"
LABEL="cockpit-smoke=$PREFIX"
BUILD_TAG="$PREFIX/app-build:smoke"

# Git Bash convertit les chemins du conteneur (« /tls ») en chemins Windows : neutralise pour tout le script.
export MSYS_NO_PATHCONV=1
# Une sortie de docker ou de curl dans une autre langue casserait les comparaisons de texte.
export LC_ALL=C

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
OVERRIDE="$ROOT/docker-compose.override.yml"
MARKER_ENV="$ROOT/.env"
MARKER_CERT="$ROOT/certs/marker.key"
MARKER_TLS="$ROOT/tls/cockpit.key"
# Fichiers .env sous app/ (comme app/.env.dev) : noms propres au test, pour ne jamais toucher un fichier de developpement reel.
MARKER_APP_DIR="$ROOT/app/smoke-marqueur"
MARKER_APP_ENV="$MARKER_APP_DIR/.env"
MARKER_APP_ENV_DOT="$ROOT/app/.env.smoke-marqueur"

FAILURES=0

say() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok   %s\n' "$*"; }
ko() {
  printf '   ECHEC %s\n' "$*" >&2
  FAILURES=$((FAILURES + 1))
}
check() {
  # check <attendu> <obtenu> <libelle>
  if [ "$1" = "$2" ]; then ok "$3"; else ko "$3 (attendu : $1 ; obtenu : $2)"; fi
}
abandon() {
  # Rien ne sert de derouler les etapes suivantes quand le cockpit ne demarre pas : le rapport serait illisible.
  printf '\n== Test de fumee interrompu : %s\n' "$*" >&2
  exit 1
}

# Garde-fou AVANT d'armer le nettoyage : le test cree (et supprime) .env, docker-compose.override.yml et tls/ a la racine.
# S'ils existent deja, c'est une vraie installation : on refuse, et surtout on n'a encore rien arme qui les effacerait.
if [ -e "$MARKER_ENV" ] || [ -e "$OVERRIDE" ] || [ -e "$ROOT/tls" ] || [ -e "$MARKER_APP_DIR" ] || [ -e "$MARKER_APP_ENV_DOT" ]; then
  echo "Refus : .env, docker-compose.override.yml, tls/, app/smoke-marqueur/ ou app/.env.smoke-marqueur existe deja dans $ROOT (le test les cree et les supprime)." >&2
  exit 2
fi

cleanup() {
  local rc=$?
  set +e
  local ids vols
  ids="$(docker ps -aq --filter "label=$LABEL" 2>/dev/null)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  vols="$(docker volume ls -q --filter "label=$LABEL" 2>/dev/null)"
  [ -n "$vols" ] && docker volume rm -f $vols >/dev/null 2>&1
  docker image rm -f "$BUILD_TAG" >/dev/null 2>&1
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    chmod -R u+w "$WORK" 2>/dev/null
    rm -rf -- "$WORK"
  fi
  rm -f -- "$OVERRIDE" "$MARKER_ENV" "$MARKER_CERT" "$MARKER_TLS" "$MARKER_APP_ENV" "$MARKER_APP_ENV_DOT"
  rmdir -- "$ROOT/tls" "$MARKER_APP_DIR" 2>/dev/null
  return $rc
}
trap cleanup EXIT

# --- Secrets du test, jamais affiches -------------------------------------------------------------------------------------
TOKEN="$(openssl rand -hex 32)"
OCPASS="$(openssl rand -hex 16)"
MARKER="marqueur-contexte-$(openssl rand -hex 16)"
HTTP_DATE="2026-09-15T10:32:00Z"

# Conteneur durci comme dans docker-compose.yml (read_only, tmpfs, cap_drop, no-new-privileges). Les dossiers que le
# cockpit ecrit sont des tmpfs jetables (mode 1777 : le serveur tourne en uid 1000) ; seul /tls est un vrai volume.
DOCKER_COMMON=(
  --label "$LABEL"
  --read-only
  --tmpfs /tmp:size=64m,mode=1777
  --tmpfs /data:size=32m,mode=1777
  --tmpfs /archives:size=16m,mode=1777
  --tmpfs /control:size=16m,mode=1777
  --tmpfs /oc-config:size=16m,mode=1777
  --tmpfs /oc-data:size=16m,mode=1777
  --tmpfs /workspace:size=16m,mode=1777
  --cap-drop ALL
  --security-opt no-new-privileges:true
  -e "COCKPIT_TOKEN=$TOKEN"
  -e "OPENCODE_SERVER_PASSWORD=$OCPASS"
  -e COCKPIT_HOST=0.0.0.0
)

C_HTTPS="$PREFIX-https"
C_HTTP="$PREFIX-http"
C_SAN="$PREFIX-san"
C_RO="$PREFIX-readonly"
C_REUSE="$PREFIX-reuse"
V_TLS="$PREFIX-tls"
V_TLS_HTTP="$PREFIX-tls-http"
V_TLS_SAN="$PREFIX-tls-san"
V_TLS_RO="$PREFIX-tls-ro"

new_volume() { docker volume create --label "$LABEL" "$1" >/dev/null; }

wait_healthy() {
  local name="$1" limit="${2:-60}" i=0 state
  while [ "$i" -lt "$limit" ]; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sans-healthcheck{{end}}' "$name" 2>/dev/null || echo absent)"
    case "$state" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 1
    i=$((i + 1))
  done
  return 1
}

wait_exit() {
  local name="$1" limit="${2:-30}" i=0 running
  while [ "$i" -lt "$limit" ]; do
    running="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
    [ "$running" = "false" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

exit_code() { docker inspect -f '{{.State.ExitCode}}' "$1"; }

# Sortie d'un conteneur ephemere : code de retour et journal, sans jamais afficher le journal brut.
run_until_exit() {
  # run_until_exit <nom> <fichier journal> [args docker run...]
  local name="$1" logfile="$2"
  shift 2
  docker run -d --name "$name" "${DOCKER_COMMON[@]}" "$@" "$IMAGE" >/dev/null
  wait_exit "$name" 30 || true
  docker logs "$name" >"$logfile" 2>&1 || true
}

# Sous Git Bash, curl.exe est un binaire Windows : il ne resout pas un chemin MSYS (« /tmp/... »). Ailleurs, identite.
if command -v cygpath >/dev/null 2>&1; then
  hostpath() { cygpath -w -- "$1"; }
else
  hostpath() { printf '%s' "$1"; }
fi

# curl epingle sur le certificat du cockpit : jamais de fichier de configuration, jamais de proxy, jamais d'autorite
# du systeme. --disable en premier argument : un ~/.curlrc ne peut rien changer a ces requetes.
CURL=(curl --disable --silent --show-error --noproxy 127.0.0.1 --max-time 15)
POUBELLE="$WORK/poubelle"

curl_code() {
  # curl_code <fichier corps> [args curl...] -> code HTTP sur stdout, 000 si la requete echoue
  local body="$1"
  shift
  "${CURL[@]}" -o "$(hostpath "$body")" -w '%{http_code}' "$@" || true
}

curl_status() {
  # curl_status [args curl...] -> code de sortie de curl
  local rc=0
  "${CURL[@]}" -o "$(hostpath "$POUBELLE")" "$@" >/dev/null 2>&1 || rc=$?
  echo "$rc"
}

curl_headers() {
  # curl_headers <fichier en-tetes> [args curl...] : en-tetes de reponse seuls, corps jete
  local head="$1"
  shift
  "${CURL[@]}" -D "$(hostpath "$head")" -o "$(hostpath "$POUBELLE")" "$@" || true
}

json_field() {
  # json_field <fichier> <champ> : valeur d'un champ JSON de premier niveau (chaine), compact ou indente, sans afficher
  # le reste du corps (il peut contenir le jeton).
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}

hmac_sha256() {
  # hmac_sha256 <cle> <fichier message> : implementation independante du serveur (openssl), pour verifier la preuve.
  openssl dgst -sha256 -hmac "$1" <"$2" | sed 's/^.*= *//'
}

########################################################################################################################
say "1/14 openssl dans l'image et paquets ajoutes"

# openssl absent de l'image : docker run echoue. Le controle doit le dire, pas arreter le script (set -e).
OPENSSL_VERSION="$(docker run --rm --label "$LABEL" --network none "$IMAGE" /usr/bin/openssl version 2>&1 || true)"
case "$OPENSSL_VERSION" in
  "OpenSSL 3."*) ok "openssl de l'image : $OPENSSL_VERSION" ;;
  *) ko "openssl de l'image absent ou inattendu : $OPENSSL_VERSION" ;;
esac

BASE_IMAGE="$(sed -n 's/^ARG NODE_IMAGE=//p' app/Dockerfile | head -n 1)"
docker run --rm --label "$LABEL" --network none "$BASE_IMAGE" dpkg-query -W -f '${Package}\n' | sort >"$WORK/paquets-base.txt"
docker run --rm --label "$LABEL" --network none "$IMAGE" dpkg-query -W -f '${Package}\n' | sort >"$WORK/paquets-app.txt"
comm -13 "$WORK/paquets-base.txt" "$WORK/paquets-app.txt" >"$WORK/paquets-ajoutes.txt"
comm -23 "$WORK/paquets-base.txt" "$WORK/paquets-app.txt" >"$WORK/paquets-retires.txt"
check "libssl3 openssl" "$(tr '\n' ' ' <"$WORK/paquets-ajoutes.txt" | sed 's/ *$//')" "paquets ajoutes a l'image de base"
check "" "$(tr '\n' ' ' <"$WORK/paquets-retires.txt" | sed 's/ *$//')" "aucun paquet retire de l'image de base"
ADDED_KIB="$(docker run --rm --label "$LABEL" --network none "$IMAGE" dpkg-query -W -f '${Installed-Size}\n' libssl3 openssl 2>/dev/null | awk '{s += $1} END {print s + 0}' || echo 0)"
printf '   info taille installee des paquets ajoutes : %s Kio (~%s Mo)\n' "$ADDED_KIB" "$((ADDED_KIB / 1024))"

########################################################################################################################
say "2/14 mode HTTPS : demarrage et etat healthy"

new_volume "$V_TLS"
docker run -d --name "$C_HTTPS" "${DOCKER_COMMON[@]}" \
  -v "$V_TLS:/tls" -p "127.0.0.1:$PORT_HTTPS:7777" "$IMAGE" >/dev/null
if wait_healthy "$C_HTTPS" 60; then
  ok "conteneur HTTPS healthy en moins de 60 s"
else
  ko "conteneur HTTPS jamais healthy"
  docker logs "$C_HTTPS" 2>&1 | tail -n 20 >&2 || true
  abandon "le mode HTTPS ne demarre pas (etapes 3 a 14 non evaluees)"
fi

########################################################################################################################
say "3/14 droits du volume TLS"

# Le controle doit rester lisible meme si l'etape 2 a echoue : les extractions ne font jamais sortir le script.
: >"$WORK/droits.txt"
docker exec "$C_HTTPS" sh -c 'for p in /tls /tls/private /tls/private/cockpit.key /tls/private/cockpit.crt /tls/public /tls/public/cockpit.crt /tls/public/cockpit-tls.json; do stat -c "%n %a %u" "$p"; done' >"$WORK/droits.txt" 2>/dev/null || true
droits() { sed -n "s|^$1 ||p" "$WORK/droits.txt"; }
check "700 1000" "$(droits /tls)" "/tls en 0700 uid 1000"
check "700 1000" "$(droits /tls/private)" "/tls/private en 0700 uid 1000"
check "600 1000" "$(droits /tls/private/cockpit.key)" "cle privee en 0600 uid 1000"
check "644 1000" "$(droits /tls/private/cockpit.crt)" "certificat prive en 0644"
check "755 1000" "$(droits /tls/public)" "/tls/public en 0755"
check "644 1000" "$(droits /tls/public/cockpit.crt)" "feuille publique en 0644"
check "644 1000" "$(droits /tls/public/cockpit-tls.json)" "cockpit-tls.json en 0644"

########################################################################################################################
say "4/14 contenu du certificat"

: >"$WORK/cockpit.crt"
: >"$WORK/cert.txt"
docker exec "$C_HTTPS" cat /tls/public/cockpit.crt >"$WORK/cockpit.crt" 2>/dev/null || true
CACERT="$(hostpath "$WORK/cockpit.crt")"
openssl x509 <"$WORK/cockpit.crt" -noout -text >"$WORK/cert.txt" 2>/dev/null || ko "certificat public illisible"
for motif in "IP Address:127.0.0.1" "DNS:localhost" "IP Address:0:0:0:0:0:0:0:1"; do
  if grep -q "$motif" "$WORK/cert.txt"; then ok "subjectAltName contient $motif"; else ko "subjectAltName sans $motif"; fi
done
if grep -q "CN *= *opencode-cockpit (local)" "$WORK/cert.txt"; then ok "sujet fixe CN=opencode-cockpit (local)"; else ko "sujet inattendu"; fi
if grep -A1 "X509v3 Basic Constraints: critical" "$WORK/cert.txt" | grep -q "CA:FALSE"; then ok "basicConstraints critique, CA:FALSE"; else ko "basicConstraints absente, non critique ou CA:TRUE"; fi
if grep -q "TLS Web Server Authentication" "$WORK/cert.txt"; then ok "extendedKeyUsage = serverAuth"; else ko "extendedKeyUsage sans serverAuth"; fi
if grep -q "id-ecPublicKey" "$WORK/cert.txt" && grep -q "prime256v1" "$WORK/cert.txt"; then ok "cle ECDSA P-256"; else ko "cle attendue : ECDSA prime256v1"; fi
DEBUT="$(openssl x509 <"$WORK/cockpit.crt" -noout -startdate 2>/dev/null | cut -d= -f2- || true)"
FIN="$(openssl x509 <"$WORK/cockpit.crt" -noout -enddate 2>/dev/null | cut -d= -f2- || true)"
if [ -n "$DEBUT" ] && [ -n "$FIN" ]; then
  JOURS=$((($(date -u -d "$FIN" +%s) - $(date -u -d "$DEBUT" +%s)) / 86400))
  check "397" "$JOURS" "validite de 397 jours"
else
  ko "validite de 397 jours (dates du certificat illisibles)"
fi

########################################################################################################################
say "5/14 mode HTTPS : curl epingle, en-tetes, preuve du jeton"

PIN="$( { openssl x509 <"$WORK/cockpit.crt" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64; } 2>/dev/null || true)"
# Empreinte d'une cle publique qui n'est pas celle du serveur : format valide, valeur fausse.
MAUVAIS_PIN="$(printf 'pas la bonne cle' | openssl dgst -sha256 -binary | openssl base64)"
BASE_HTTPS="https://127.0.0.1:$PORT_HTTPS"

check "200" "$(curl_code "$WORK/sante.json" --cacert "$CACERT" --pinnedpubkey "sha256//$PIN" "$BASE_HTTPS/api/health")" "curl --cacert + --pinnedpubkey : 200"
check "https" "$(json_field "$WORK/sante.json" scheme)" "/api/health annonce le schema https"
check "90" "$(curl_status --cacert "$CACERT" --pinnedpubkey "sha256//$MAUVAIS_PIN" "$BASE_HTTPS/api/health")" "mauvaise empreinte epinglee : curl 90"
check "60" "$(curl_status --pinnedpubkey "sha256//$PIN" "$BASE_HTTPS/api/health")" "--pinnedpubkey sans --cacert : curl 60"
CODE_CLAIR="$(curl_status --proto '=http' "http://127.0.0.1:$PORT_HTTPS/api/health")"
case "$CODE_CLAIR" in
  52 | 56) ok "HTTP en clair sur le port TLS : curl $CODE_CLAIR (aucun octet interprete)" ;;
  *) ko "HTTP en clair sur le port TLS : curl $CODE_CLAIR (52 ou 56 attendus)" ;;
esac

curl_headers "$WORK/entetes-api-https.txt" --cacert "$CACERT" "$BASE_HTTPS/api/health"
curl_headers "$WORK/entetes-page-https.txt" --cacert "$CACERT" "$BASE_HTTPS/"
if grep -qi '^strict-transport-security' "$WORK/entetes-api-https.txt" "$WORK/entetes-page-https.txt"; then
  ko "HSTS present en HTTPS"
else
  ok "aucun en-tete HSTS en HTTPS"
fi
CSP_API_HTTPS="$(grep -i '^content-security-policy:' "$WORK/entetes-api-https.txt" | tr -d '\r')"
CSP_PAGE_HTTPS="$(grep -i '^content-security-policy:' "$WORK/entetes-page-https.txt" | tr -d '\r')"
if [ -n "$CSP_API_HTTPS" ] && [ -n "$CSP_PAGE_HTTPS" ]; then ok "CSP servie sur l'API et sur la page"; else ko "CSP absente en HTTPS"; fi

DEFI="$(openssl rand -hex 32)"
printf 'opencode-cockpit/health-proof/v1\n%s' "$DEFI" >"$WORK/message-preuve.bin"
PREUVE_ATTENDUE="$(hmac_sha256 "$TOKEN" "$WORK/message-preuve.bin")"
check "200" "$(curl_code "$WORK/preuve.json" --cacert "$CACERT" --pinnedpubkey "sha256//$PIN" "$BASE_HTTPS/api/health?challenge=$DEFI")" "/api/health?challenge= : 200"
if [ "$(json_field "$WORK/preuve.json" proof)" = "$PREUVE_ATTENDUE" ] && [ -n "$PREUVE_ATTENDUE" ]; then
  ok "preuve du jeton conforme au HMAC calcule par openssl"
else
  ko "preuve du jeton non conforme"
fi
check "400" "$(curl_code "$POUBELLE" --cacert "$CACERT" "$BASE_HTTPS/api/health?challenge=pas-un-defi")" "defi invalide : 400"

########################################################################################################################
say "6/14 redemarrage : meme empreinte ; cle aux droits elargis : demarrage refuse"

EMPREINTE_AVANT="$(openssl x509 <"$WORK/cockpit.crt" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"
docker restart "$C_HTTPS" >/dev/null
if wait_healthy "$C_HTTPS" 60; then ok "conteneur HTTPS healthy apres redemarrage"; else ko "conteneur HTTPS jamais healthy apres redemarrage"; fi
docker exec "$C_HTTPS" cat /tls/public/cockpit.crt >"$WORK/cockpit-2.crt" 2>/dev/null || true
EMPREINTE_APRES="$(openssl x509 <"$WORK/cockpit-2.crt" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"
check "$EMPREINTE_AVANT" "$EMPREINTE_APRES" "certificat inchange apres redemarrage"
docker exec "$C_HTTPS" cat /tls/public/cockpit-tls.json >"$WORK/cockpit-tls.json" 2>/dev/null || true
check "$EMPREINTE_AVANT" "$(json_field "$WORK/cockpit-tls.json" sha256)" "cockpit-tls.json annonce la meme empreinte"
if grep -qi 'BEGIN' "$WORK/cockpit-tls.json"; then ko "cockpit-tls.json contient un bloc PEM"; else ok "cockpit-tls.json sans bloc PEM"; fi

docker stop "$C_HTTPS" >/dev/null
docker run --rm --label "$LABEL" --network none -v "$V_TLS:/tls" "$IMAGE" chmod 0644 /tls/private/cockpit.key
docker start "$C_HTTPS" >/dev/null
wait_exit "$C_HTTPS" 30 || true
docker logs "$C_HTTPS" >"$WORK/journal-droits.txt" 2>&1 || true
check "1" "$(exit_code "$C_HTTPS")" "cle en 0644 : sortie 1 (aucune reparation silencieuse)"
if grep -q '"raison":"droits-cle"' "$WORK/journal-droits.txt"; then ok "journal : raison droits-cle"; else ko "journal sans la raison droits-cle"; fi
if grep -q 'HTTPS local impossible' "$WORK/journal-droits.txt"; then ok "journal : HTTPS local impossible"; else ko "journal sans « HTTPS local impossible »"; fi
if grep -qi 'BEGIN' "$WORK/journal-droits.txt"; then ko "le journal contient un bloc PEM"; else ok "journal sans bloc PEM"; fi
docker run --rm --label "$LABEL" --network none -v "$V_TLS:/tls" "$IMAGE" chmod 0600 /tls/private/cockpit.key
docker start "$C_HTTPS" >/dev/null
if wait_healthy "$C_HTTPS" 60; then ok "droits retablis : conteneur de nouveau healthy"; else ko "conteneur non reparti apres retablissement des droits"; fi

########################################################################################################################
say "7/14 subjectAltName : hotes supplementaires valides, hotes refuses"

new_volume "$V_TLS_SAN"
docker run -d --name "$C_SAN" "${DOCKER_COMMON[@]}" -v "$V_TLS_SAN:/tls" \
  -e 'COCKPIT_ALLOWED_HOSTS=localhost,127.0.0.1,[::1],cockpit.localhost,evil,DNS:x' "$IMAGE" >/dev/null
if wait_healthy "$C_SAN" 60; then ok "conteneur SAN healthy"; else ko "conteneur SAN jamais healthy"; fi
docker exec "$C_SAN" cat /tls/public/cockpit.crt >"$WORK/san.crt" 2>/dev/null || true
: >"$WORK/san.txt"; openssl x509 <"$WORK/san.crt" -noout -text >"$WORK/san.txt" 2>/dev/null || ko "certificat SAN illisible"
if grep -q "DNS:cockpit.localhost" "$WORK/san.txt"; then ok "DNS:cockpit.localhost ajoute"; else ko "DNS:cockpit.localhost absent"; fi
if grep -q "DNS:x\b" "$WORK/san.txt"; then ko "« DNS:x » recopie dans le certificat"; else ok "« DNS:x » ecarte du certificat"; fi
docker logs "$C_SAN" >"$WORK/journal-san.txt" 2>&1 || true
# La valeur journalisee est deja normalisee en minuscules par la configuration, et reduite a l'ASCII imprimable.
if grep -q 'certificat TLS local' "$WORK/journal-san.txt" && grep -q '"valeur":"dns:x"' "$WORK/journal-san.txt"; then
  ok "journal : hote ignore, valeur reduite a l'ASCII imprimable"
else
  ko "journal sans la trace de l'hote ignore"
fi
docker rm -f "$C_SAN" >/dev/null

########################################################################################################################
say "8/14 /tls en lecture seule : echec franc, rien n'ecoute"

new_volume "$V_TLS_RO"
docker run -d --name "$C_RO" "${DOCKER_COMMON[@]}" -v "$V_TLS_RO:/tls:ro" -p "127.0.0.1:$PORT_HTTP:7777" "$IMAGE" >/dev/null
wait_exit "$C_RO" 30 || true
docker logs "$C_RO" >"$WORK/journal-ro.txt" 2>&1 || true
if [ "$(exit_code "$C_RO")" != "0" ]; then ok "volume en lecture seule : sortie non nulle"; else ko "volume en lecture seule : sortie 0"; fi
if grep -q 'HTTPS local impossible' "$WORK/journal-ro.txt"; then ok "journal : HTTPS local impossible"; else ko "journal sans « HTTPS local impossible »"; fi
if [ "$(curl_status --proto '=http' "http://127.0.0.1:$PORT_HTTP/api/health")" != "0" ]; then
  ok "rien n'ecoute sur le port publie"
else
  ko "une reponse est servie alors que le demarrage a echoue"
fi
docker rm -f "$C_RO" >/dev/null

########################################################################################################################
say "9/14 mode HTTP : valeurs refusees"

run_until_exit "$PREFIX-http-sans-date" "$WORK/journal-sans-date.txt" -e COCKPIT_LOCAL_SCHEME=http
if [ "$(exit_code "$PREFIX-http-sans-date")" != "0" ]; then ok "http sans date : sortie non nulle"; else ko "http sans date accepte"; fi
if grep -q 'COCKPIT_LOCAL_HTTP_CONFIRMED' "$WORK/journal-sans-date.txt"; then ok "journal : la cle en cause est nommee"; else ko "journal sans le nom de la cle"; fi

run_until_exit "$PREFIX-http-majuscules" "$WORK/journal-majuscules.txt" -e COCKPIT_LOCAL_SCHEME=HTTP -e "COCKPIT_LOCAL_HTTP_CONFIRMED=$HTTP_DATE"
if [ "$(exit_code "$PREFIX-http-majuscules")" != "0" ]; then ok "COCKPIT_LOCAL_SCHEME=HTTP refuse"; else ko "COCKPIT_LOCAL_SCHEME=HTTP accepte"; fi
if grep -q 'COCKPIT_LOCAL_SCHEME' "$WORK/journal-majuscules.txt"; then ok "journal : la cle en cause est nommee"; else ko "journal sans le nom de la cle"; fi

run_until_exit "$PREFIX-http-date-impossible" "$WORK/journal-date.txt" -e COCKPIT_LOCAL_SCHEME=http -e COCKPIT_LOCAL_HTTP_CONFIRMED=2026-02-30T00:00:00Z
if [ "$(exit_code "$PREFIX-http-date-impossible")" != "0" ]; then ok "date du 30 fevrier refusee"; else ko "date du 30 fevrier acceptee"; fi

########################################################################################################################
say "10/14 mode HTTP complet"

new_volume "$V_TLS_HTTP"
docker run -d --name "$C_HTTP" "${DOCKER_COMMON[@]}" -v "$V_TLS_HTTP:/tls" -p "127.0.0.1:$PORT_HTTP:7777" \
  -e COCKPIT_LOCAL_SCHEME=http -e "COCKPIT_LOCAL_HTTP_CONFIRMED=$HTTP_DATE" "$IMAGE" >/dev/null
if wait_healthy "$C_HTTP" 60; then ok "conteneur HTTP healthy en moins de 60 s"; else ko "conteneur HTTP jamais healthy"; fi
BASE_HTTP="http://127.0.0.1:$PORT_HTTP"

check "200" "$(curl_code "$WORK/sante-http.json" --proto '=http' "$BASE_HTTP/api/health")" "/api/health en HTTP : 200"
check "http" "$(json_field "$WORK/sante-http.json" scheme)" "/api/health annonce le schema http"
check "35" "$(curl_status --proto '=https' "https://127.0.0.1:$PORT_HTTP/api/health")" "TLS sur le port HTTP : curl 35"
check "0" "$(docker exec "$C_HTTP" sh -c 'find /tls -type f | wc -l' | tr -d ' \r')" "aucun fichier ecrit dans /tls en mode HTTP"

curl_headers "$WORK/entetes-api-http.txt" --proto '=http' "$BASE_HTTP/api/health"
curl_headers "$WORK/entetes-page-http.txt" --proto '=http' "$BASE_HTTP/"
if grep -qi '^strict-transport-security' "$WORK/entetes-api-http.txt" "$WORK/entetes-page-http.txt"; then
  ko "HSTS present en HTTP"
else
  ok "aucun en-tete HSTS en HTTP"
fi
check "$CSP_API_HTTPS" "$(grep -i '^content-security-policy:' "$WORK/entetes-api-http.txt" | tr -d '\r')" "CSP de l'API identique dans les deux modes"
check "$CSP_PAGE_HTTPS" "$(grep -i '^content-security-policy:' "$WORK/entetes-page-http.txt" | tr -d '\r')" "CSP de la page identique dans les deux modes"

CODE_LOGIN="$(curl_code "$WORK/login.json" --proto '=http' -X POST -H 'content-type: application/json' -H 'x-cockpit-csrf: 1' --data '{"token":"x"}' "$BASE_HTTP/api/login")"
check "403" "$CODE_LOGIN" "POST /api/login refuse en HTTP"
check "login-disabled" "$(json_field "$WORK/login.json" error)" "motif du refus : login-disabled"

DEFI_HTTP="$(openssl rand -hex 32)"
printf 'opencode-cockpit/health-proof/v1\n%s' "$DEFI_HTTP" >"$WORK/message-preuve-http.bin"
PREUVE_HTTP_ATTENDUE="$(hmac_sha256 "$TOKEN" "$WORK/message-preuve-http.bin")"
# Demande de ticket : seulement signee par le jeton (HMAC du defi, usage auth-ticket-request), une seule fois par defi.
check "403" "$(curl_code "$WORK/ticket-non-signe.json" --proto '=http' "$BASE_HTTP/api/health?challenge=$DEFI_HTTP&ticket=1")" "demande de ticket non signee par le jeton : 403"
if [ -z "$(json_field "$WORK/ticket-non-signe.json" ticket)" ]; then ok "aucun ticket sans demande signee"; else ko "ticket emis sans demande signee"; fi
printf 'opencode-cockpit/auth-ticket-request/v1\n%s' "$DEFI_HTTP" >"$WORK/message-demande-http.bin"
DEMANDE_HTTP="$(hmac_sha256 "$TOKEN" "$WORK/message-demande-http.bin")"
check "200" "$(curl_code "$WORK/preuve-http.json" --proto '=http' "$BASE_HTTP/api/health?challenge=$DEFI_HTTP&ticket=$DEMANDE_HTTP")" "demande de ticket signee : 200"
if [ "$(json_field "$WORK/preuve-http.json" proof)" = "$PREUVE_HTTP_ATTENDUE" ] && [ -n "$PREUVE_HTTP_ATTENDUE" ]; then
  ok "preuve du jeton conforme en mode HTTP"
else
  ko "preuve du jeton non conforme en mode HTTP"
fi
TICKET="$(json_field "$WORK/preuve-http.json" ticket)"
if printf '%s' "$TICKET" | grep -Eq '^[0-9a-f]{64}$'; then ok "ticket de connexion au format attendu"; else ko "ticket de connexion absent ou mal forme"; fi
check "403" "$(curl_code "$POUBELLE" --proto '=http' "$BASE_HTTP/api/health?challenge=$DEFI_HTTP&ticket=$DEMANDE_HTTP")" "demande de ticket rejouee : 403"
docker stop "$C_HTTP" >/dev/null

########################################################################################################################
say "11/14 volume TLS : sejour en mode HTTP, puis tls -Renew"

docker stop "$C_HTTPS" >/dev/null
CONDENSE_AVANT="$(docker run --rm --label "$LABEL" --network none -v "$V_TLS:/tls" "$IMAGE" sha256sum /tls/private/cockpit.key | cut -d' ' -f1)"
docker run -d --name "$C_REUSE" "${DOCKER_COMMON[@]}" -v "$V_TLS:/tls" \
  -e COCKPIT_LOCAL_SCHEME=http -e "COCKPIT_LOCAL_HTTP_CONFIRMED=$HTTP_DATE" "$IMAGE" >/dev/null
if wait_healthy "$C_REUSE" 60; then ok "mode HTTP sur un volume TLS deja garni : healthy"; else ko "mode HTTP sur un volume TLS deja garni : jamais healthy"; fi
docker stop "$C_REUSE" >/dev/null
CONDENSE_APRES="$(docker run --rm --label "$LABEL" --network none -v "$V_TLS:/tls" "$IMAGE" sha256sum /tls/private/cockpit.key | cut -d' ' -f1)"
if [ "$CONDENSE_AVANT" = "$CONDENSE_APRES" ] && [ -n "$CONDENSE_AVANT" ]; then
  ok "cle privee inchangee par le sejour en mode HTTP (condenses compares, jamais affiches)"
else
  ko "cle privee modifiee par le sejour en mode HTTP"
fi
docker start "$C_HTTPS" >/dev/null
if wait_healthy "$C_HTTPS" 60; then ok "retour en HTTPS : healthy"; else ko "retour en HTTPS : jamais healthy"; fi
docker exec "$C_HTTPS" cat /tls/public/cockpit.crt >"$WORK/cockpit-3.crt" 2>/dev/null || true
check "$EMPREINTE_AVANT" "$(openssl x509 <"$WORK/cockpit-3.crt" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)" "meme certificat au retour en HTTPS"

# « .\cockpit.ps1 tls -Renew » : meme suppression que le script (cle et certificats ; cockpit-tls.json reste), puis
# demarrage. Le serveur cree une nouvelle paire et annonce l'empreinte precedente, lue dans le JSON garde.
docker stop "$C_HTTPS" >/dev/null
docker run --rm --label "$LABEL" --network none --user 1000:1000 --entrypoint rm -v "$V_TLS:/tls" "$IMAGE" \
  -f /tls/private/cockpit.key /tls/private/cockpit.crt /tls/public/cockpit.crt
docker start "$C_HTTPS" >/dev/null
if wait_healthy "$C_HTTPS" 60; then ok "tls -Renew : conteneur healthy avec une nouvelle paire"; else ko "tls -Renew : conteneur jamais healthy"; fi
: >"$WORK/cockpit-4.crt"
: >"$WORK/cockpit-tls-4.json"
docker exec "$C_HTTPS" cat /tls/public/cockpit.crt >"$WORK/cockpit-4.crt" 2>/dev/null || true
docker exec "$C_HTTPS" cat /tls/public/cockpit-tls.json >"$WORK/cockpit-tls-4.json" 2>/dev/null || true
EMPREINTE_RENOUVELEE="$(openssl x509 <"$WORK/cockpit-4.crt" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"
if [ -n "$EMPREINTE_RENOUVELEE" ] && [ "$EMPREINTE_RENOUVELEE" != "$EMPREINTE_AVANT" ]; then
  ok "tls -Renew : nouvelle empreinte"
else
  ko "tls -Renew : empreinte inchangee ou certificat illisible"
fi
check "$EMPREINTE_RENOUVELEE" "$(json_field "$WORK/cockpit-tls-4.json" sha256)" "tls -Renew : cockpit-tls.json annonce la nouvelle empreinte"
check "$EMPREINTE_AVANT" "$(json_field "$WORK/cockpit-tls-4.json" previousSha256)" "tls -Renew : previousSha256 = ancienne empreinte"
docker rm -f "$C_HTTPS" "$C_REUSE" >/dev/null

########################################################################################################################
say "12/14 couches ajoutees a l'image de base : aucun bloc de cle privee"

# Motif assemble a l'execution : aucune etiquette PEM complete n'est ecrite dans le depot. Toute etiquette « ... PRIVATE KEY »
# (PKCS#8, RSA, EC, DSA, OPENSSH, ENCRYPTED), fin de ligne Unix ou Windows, puis une ligne base64.
ETIQUETTE="PRIVATE KEY"
MOTIF_PEM="-----BEGIN ([A-Z0-9]+ )*$ETIQUETTE-----\r?\n[A-Za-z0-9+/=]{40,}"

# Seules les couches AJOUTEES par app/Dockerfile sont examinees. Les couches de NODE_IMAGE (epinglee par condense) viennent de
# Debian et de Node : le paquet libgnutls30 y embarque des cles d'auto-test FIPS au format PEM
# (/usr/lib/x86_64-linux-gnu/libgnutls.so.30.*), hors de notre controle. Les couches sont comparees par leurs condenses de
# contenu (.RootFS.Layers) : celles de l'image de base doivent former exactement le debut de celles de l'image, sinon
# toutes les couches sont examinees.
docker image inspect -f '{{range .RootFS.Layers}}{{println .}}{{end}}' "$BASE_IMAGE" | tr -d '\r' | sed '/^$/d' >"$WORK/couches-base.txt"
docker image inspect -f '{{range .RootFS.Layers}}{{println .}}{{end}}' "$IMAGE" | tr -d '\r' | sed '/^$/d' >"$WORK/couches-image.txt"
NB_BASE="$(wc -l <"$WORK/couches-base.txt" | tr -d ' ')"
NB_IMAGE="$(wc -l <"$WORK/couches-image.txt" | tr -d ' ')"
head -n "$NB_BASE" "$WORK/couches-image.txt" >"$WORK/couches-debut.txt"
if [ "$NB_BASE" -ge 1 ] && [ "$NB_IMAGE" -gt "$NB_BASE" ] && [ "$(cat "$WORK/couches-debut.txt")" = "$(cat "$WORK/couches-base.txt")" ]; then
  ok "l'image part de NODE_IMAGE : $NB_BASE couche(s) de base identiques, non examinees"
  tail -n +"$((NB_BASE + 1))" "$WORK/couches-image.txt" >"$WORK/couches-ajoutees.txt"
else
  ko "les couches de NODE_IMAGE ($NB_BASE) ne forment pas le debut de celles de l'image ($NB_IMAGE) : toutes les couches sont examinees"
  cp "$WORK/couches-image.txt" "$WORK/couches-ajoutees.txt"
fi
sort -u "$WORK/couches-ajoutees.txt" >"$WORK/couches-a-examiner.txt"
NB_A_EXAMINER="$(wc -l <"$WORK/couches-a-examiner.txt" | tr -d ' ')"

# Sortie par redirection du shell, jamais par « -o <chemin> » : docker ne resout pas un chemin MSYS (Git Bash).
docker save "$IMAGE" >"$WORK/image.tar"
mkdir -p "$WORK/save"
tar -xf "$WORK/image.tar" -C "$WORK/save"
rm -f "$WORK/image.tar"

# Contenu tar d'un fichier de docker save, selon sa signature : gzip, zstd, sinon tel quel (tar, ou fichier JSON).
decompresser() {
  case "$(head -c 4 -- "$1" | od -An -tx1 | tr -d ' \n')" in
    1f8b*) gzip -dc -- "$1" ;;
    28b52ffd) zstd -dcq -- "$1" ;;
    *) cat -- "$1" ;;
  esac
}

: >"$WORK/couches-examinees.txt"
COUCHES_SUSPECTES=0
while IFS= read -r blob; do
  [ -n "$blob" ] || continue
  # Condense du contenu decompresse = identifiant de la couche dans .RootFS.Layers (un fichier JSON n'y figure jamais).
  CONDENSE="sha256:$( { decompresser "$blob" 2>/dev/null || true; } | sha256sum | cut -d' ' -f1)"
  grep -qxF -- "$CONDENSE" "$WORK/couches-a-examiner.txt" || continue
  COURT="${CONDENSE#sha256:}"
  COURT="${COURT:0:12}"
  # Ni « grep -q » ni tube interrompu : sous « set -o pipefail », un tar coupe par SIGPIPE ferait passer une couche suspecte
  # pour saine. Chaque code de retour est lu : grep 0 = trouve, 1 = rien, 2 ou plus = erreur (jamais comptee comme saine).
  set +e
  decompresser "$blob" 2>/dev/null | tar -xOf - 2>"$WORK/tar.err" | grep -aPzc -- "$MOTIF_PEM" >"$WORK/grep.out" 2>"$WORK/grep.err"
  STATUTS="${PIPESTATUS[0]} ${PIPESTATUS[1]} ${PIPESTATUS[2]}"
  set -e
  read -r RC_DECOMP RC_TAR RC_GREP <<<"$STATUTS"
  if [ "$RC_DECOMP" -ne 0 ] || [ "$RC_TAR" -ne 0 ]; then
    ko "couche $COURT illisible (decompression $RC_DECOMP, tar $RC_TAR : $(head -n 1 "$WORK/tar.err"))"
    continue
  fi
  case "$RC_GREP" in
    0)
      COUCHES_SUSPECTES=$((COUCHES_SUSPECTES + 1))
      ko "couche $COURT : $(head -n 1 "$WORK/grep.out") enregistrement(s) « etiquette PEM + ligne base64 »"
      # Fichiers en cause (noms seulement, jamais le contenu).
      mkdir -p "$WORK/suspecte"
      { decompresser "$blob" 2>/dev/null || true; } | tar -xf - -C "$WORK/suspecte" 2>/dev/null || true
      { grep -rlaPz -- "$MOTIF_PEM" "$WORK/suspecte" 2>/dev/null || true; } | sed "s|^$WORK/suspecte|        |" | head -n 20 >&2
      chmod -R u+w "$WORK/suspecte" 2>/dev/null || true
      rm -rf -- "$WORK/suspecte"
      ;;
    1) ;;
    *)
      ko "couche $COURT : grep en erreur ($RC_GREP : $(head -n 1 "$WORK/grep.err"))"
      continue
      ;;
  esac
  printf '%s\n' "$CONDENSE" >>"$WORK/couches-examinees.txt"
done <<EOF
$(find "$WORK/save" -type f)
EOF
sort -u "$WORK/couches-examinees.txt" >"$WORK/couches-lues.txt"
NB_MANQUANTES="$(comm -23 "$WORK/couches-a-examiner.txt" "$WORK/couches-lues.txt" | wc -l | tr -d ' ')"
if [ "$NB_A_EXAMINER" -ge 1 ] && [ "$NB_MANQUANTES" -eq 0 ]; then
  ok "$NB_A_EXAMINER couche(s) ajoutee(s), toutes retrouvees dans docker save et lues en entier"
else
  ko "couches ajoutees : $NB_A_EXAMINER attendue(s), $NB_MANQUANTES non retrouvee(s) ou illisible(s) dans docker save"
fi
check "0" "$COUCHES_SUSPECTES" "aucune couche ajoutee ne contient « etiquette PEM + ligne base64 »"
docker history --no-trunc "$IMAGE" >"$WORK/history.txt"
if grep -q "$ETIQUETTE" "$WORK/history.txt"; then ko "docker history mentionne une cle privee"; else ok "docker history sans mention de cle privee"; fi

########################################################################################################################
say "13/14 contexte de construction"

mkdir -p "$ROOT/tls" "$MARKER_APP_DIR"
printf '%s\n' "$MARKER" >"$MARKER_ENV"
printf '%s\n' "$MARKER" >"$MARKER_CERT"
printf '%s\n' "$MARKER" >"$MARKER_TLS"
printf '%s\n' "$MARKER" >"$MARKER_APP_ENV"
printf '%s\n' "$MARKER" >"$MARKER_APP_ENV_DOT"

# Journal de construction en echec : dernieres lignes, identifiants d'une adresse de proxy masques.
journal_construction() { tail -n 20 "$1" | sed -E 's#://[^/@[:space:]]+@#://****@#g' >&2 || true; }

# Constructions par « docker buildx build » : avec le pilote docker-container (docker/setup-buildx-action en CI), l'image
# n'est chargee dans le demon qu'avec --load, et « docker build » sans sortie la laisse dans le cache du constructeur.
# Sortie en archive sur la sortie standard puis extraction par tar : « dest=<chemin> » ne resout pas un chemin MSYS.
if ! docker buildx build --file .github/ci/context-probe.Dockerfile --output type=tar,dest=- . >"$WORK/ctx.tar" 2>"$WORK/ctx-build.log"; then
  ko "sonde de contexte : construction impossible"
  journal_construction "$WORK/ctx-build.log"
fi
mkdir -p "$WORK/ctx"
tar -xf "$WORK/ctx.tar" -C "$WORK/ctx" 2>/dev/null || true
if [ -d "$WORK/ctx/contexte" ]; then ok "sonde de contexte executee"; else ko "sonde de contexte sans sortie"; fi
# « grep ne trouve rien » est le resultat attendu : son code 1 ne doit pas arreter le script (set -o pipefail).
TROUVES="$( { grep -rl -- "$MARKER" "$WORK/ctx" 2>/dev/null || true; } | wc -l | tr -d ' ')"
check "0" "$TROUVES" "aucun marqueur dans le contexte transmis au demon"
for absent in contexte/.env contexte/app/.env.smoke-marqueur contexte/app/smoke-marqueur/.env contexte/certs/marker.key contexte/tls/cockpit.key contexte/app/node_modules contexte/tests; do
  if [ -e "$WORK/ctx/$absent" ]; then ko "$absent present dans le contexte"; else ok "$absent absent du contexte"; fi
done
if [ -e "$WORK/ctx/contexte/certs/README.md" ]; then ok "certs/README.md conserve (les autorites d'entreprise restent montables)"; else ko "certs/ entierement exclu du contexte"; fi

if docker buildx build --load --file app/Dockerfile --target build --tag "$BUILD_TAG" . >"$WORK/build-etape.log" 2>&1; then
  RESTES="$(docker run --rm --label "$LABEL" --network none -e "SMOKE_MARKER=$MARKER" "$BUILD_TAG" \
    sh -c 'grep -rl --exclude-dir=node_modules -- "$SMOKE_MARKER" /src /tmp 2>/dev/null | wc -l' | tr -d ' \r')" || RESTES="illisible"
  check "0" "$RESTES" "etape de construction sans marqueur"
  if docker run --rm --label "$LABEL" --network none "$BUILD_TAG" \
    sh -c 'test ! -e /tmp/cockpit-certs && test ! -e /src/certs && test ! -e /src/.env && test ! -e /src/.env.smoke-marqueur && test ! -e /src/smoke-marqueur/.env'; then
    ok "etape de construction : ni certs/ monte, ni certs/, ni .env (racine ou app/)"
  else
    ko "etape de construction : certs/ ou un .env present dans une couche"
  fi
else
  ko "construction de l'etape « build » impossible (docker buildx build --load)"
  journal_construction "$WORK/build-etape.log"
fi

rm -f -- "$MARKER_ENV" "$MARKER_CERT" "$MARKER_TLS" "$MARKER_APP_ENV" "$MARKER_APP_ENV_DOT"
rmdir -- "$ROOT/tls" "$MARKER_APP_DIR" 2>/dev/null || true

########################################################################################################################
say "14/14 docker compose : montages, port et priorite des variables"

# .env factice a la racine, comme sur une vraie installation (compose ne lit pas un chemin MSYS passe a --env-file) :
# le garde de tete a verifie qu'il n'en existait pas, et le trap le supprime. Aucun conteneur n'est demarre ici.
cat >"$MARKER_ENV" <<EOF
COMPOSE_PROJECT_NAME=$PREFIX-compose
COCKPIT_TOKEN=$TOKEN
OPENCODE_SERVER_PASSWORD=$OCPASS
WORKSPACE_DIR=/tmp/$PREFIX-workspace
ARCHIVE_DIR=/tmp/$PREFIX-archives
COCKPIT_PORT=$PORT_HTTPS
COCKPIT_VERSION=smoke
COCKPIT_LOCAL_SCHEME=https
COCKPIT_LOCAL_HTTP_CONFIRMED=
EOF

# Le verificateur tourne dans l'image : ni jq ni node ne sont exiges de la machine, et la configuration (qui contient le
# jeton) n'est jamais affichee.
VERIF='
const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const lignes = [];
const dit = (ok, texte) => lignes.push(`${ok ? "   ok   " : "   ECHEC "}${texte}`);
const vol = (service) => (data.services?.[service]?.volumes ?? []).map((v) => `${v.type === "volume" ? v.source : "(hote)"}:${v.target}${v.read_only ? ":ro" : ""}`);
const oc = vol("opencode");
const cockpit = vol("cockpit");
dit(!oc.some((v) => v.includes("/tls")), "service opencode : aucun montage /tls");
dit(cockpit.includes("cockpit-tls:/tls"), "service cockpit : volume cockpit-tls monte sur /tls");
dit(!cockpit.some((v) => /\/(workspace|control)\/.*tls/.test(v)), "aucun /tls sous /workspace ni /control");
const ports = data.services?.cockpit?.ports ?? [];
dit(ports.length === 1 && ports[0].host_ip === "127.0.0.1", "un seul port publie, sur 127.0.0.1");
dit(data.volumes?.["cockpit-tls"] !== undefined, "volume cockpit-tls declare");
const attendu = process.env.SMOKE_SCHEME_ATTENDU;
const servi = data.services?.cockpit?.environment?.COCKPIT_LOCAL_SCHEME;
dit(servi === attendu, `COCKPIT_LOCAL_SCHEME rendu par compose = ${attendu}`);
console.log(lignes.join("\n"));
process.exit(lignes.some((l) => l.includes("ECHEC")) ? 1 : 0);
'

verifier_compose() {
  # verifier_compose <fichier json> <schema attendu> <libelle de la configuration>
  local sortie rc=0
  printf '   -- %s\n' "$3"
  sortie="$(docker run --rm -i --label "$LABEL" --network none -e "SMOKE_SCHEME_ATTENDU=$2" "$IMAGE" node -e "$VERIF" <"$1")" || rc=$?
  printf '%s\n' "$sortie"
  [ "$rc" -eq 0 ] || FAILURES=$((FAILURES + 1))
}

docker compose -f docker-compose.yml config --format json >"$WORK/compose-https.json" 2>"$WORK/compose-https.err"
verifier_compose "$WORK/compose-https.json" https ".env seul"

# Constat fige 1 (P12) : un docker-compose.override.yml voisin est charge par la decouverte automatique, mais jamais
# quand le fichier est nomme explicitement par -f. C'est ce qui justifie le « -f » de chaque commande des scripts.
cat >"$OVERRIDE" <<'EOF'
services:
  cockpit:
    environment:
      COCKPIT_LOCAL_SCHEME: http
      COCKPIT_LOCAL_HTTP_CONFIRMED: "2026-09-15T10:32:00Z"
EOF
docker compose -f docker-compose.yml config --format json >"$WORK/compose-avec-f.json" 2>/dev/null
verifier_compose "$WORK/compose-avec-f.json" https "override voisin, fichier nomme par -f (ignore)"
docker compose config --format json >"$WORK/compose-sans-f.json" 2>/dev/null
verifier_compose "$WORK/compose-sans-f.json" http "override voisin, sans -f (charge : constat fige P12)"
rm -f -- "$OVERRIDE"

# Constat fige 2 (P12) : une variable du shell l'emporte sur .env, d'ou le masquage cote scripts (§3.3).
COCKPIT_LOCAL_SCHEME=http COCKPIT_LOCAL_HTTP_CONFIRMED="$HTTP_DATE" \
  docker compose -f docker-compose.yml config --format json >"$WORK/compose-shell.json" 2>/dev/null
verifier_compose "$WORK/compose-shell.json" http "variables du shell prioritaires sur .env (constat fige P12)"

########################################################################################################################
if [ "$FAILURES" -eq 0 ]; then
  printf '\n== Test de fumee : 14 etapes, aucun echec.\n'
  exit 0
fi
printf '\n== Test de fumee : %s controle(s) en echec.\n' "$FAILURES" >&2
exit 1
