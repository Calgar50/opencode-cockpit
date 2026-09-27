#!/usr/bin/env bash
# Test de fumee de la migration du web 1.0.x -> 1.1.0 (decision A37, fiche MW T8) : server/migrate-oc-config.ts dans l'image app,
# lance comme install.ps1 et cockpit.ps1 restore le lancent (CockpitTls.ps1, Get-CockpitWebMigrationArgs) :
#   --pull never --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32
#
#   bash .github/ci/migration-web-smoke.sh <image app>
#
# Cas Linux qui portent la surete du script (liens, tube, droits, uid), joues aussi en local : ils n'attendent pas la CI.
# Volumes nommes et entree standard seulement, aucun montage de dossier (marche sous Git Bash). Les fichiers sont poses et donnes
# a l'uid 1000 par un conteneur d'aide root en --network none.
#
# Reglage : SMOKE_MW_PREFIX, prefixe des conteneurs et des volumes crees (defaut : migration-web-smoke). Le nettoyage, par trap,
# ne supprime que les conteneurs et les volumes dont le nom commence par ce prefixe.
set -euo pipefail

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: migration-web-smoke.sh <image>" >&2
  exit 2
fi
PREFIX="${SMOKE_MW_PREFIX:-migration-web-smoke}"
case "$PREFIX" in
  opencode-cockpit* | ocauto*)
    echo "Refus : le prefixe $PREFIX designe les ressources de l'utilisateur." >&2
    exit 2
    ;;
esac

# Git Bash convertirait les chemins du conteneur (« /oc-config ») en chemins Windows : neutralise pour tout le script.
export MSYS_NO_PATHCONV=1
export LC_ALL=C

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
FIXTURE="$ROOT/app/server/test-support/oc-config-1.0.6.jsonc"
WORK="$(mktemp -d)"
FAILURES=0
SEQ=0
OUT=""
CODE=0

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

cleanup() {
  local rc=$?
  set +e
  local ids vols
  ids="$(docker ps -aq --filter "name=^${PREFIX}-" 2>/dev/null)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  vols="$(docker volume ls -q --filter "name=^${PREFIX}-" 2>/dev/null)"
  [ -n "$vols" ] && docker volume rm -f $vols >/dev/null 2>&1
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

# Volume neuf, dossier racine donne a l'uid 1000 (comme le chown -R d'install.ps1).
nouveau_volume() {
  SEQ=$((SEQ + 1))
  VOL="$PREFIX-$SEQ"
  docker volume create "$VOL" >/dev/null
  aide "$VOL" 'chown 1000:1000 /d'
}
# Conteneur d'aide root, sans reseau, volume sur /d ; script sh en argument, entree standard transmise.
aide() {
  docker run --rm -i --network none --user 0 --entrypoint sh -v "$1:/d" "$IMAGE" -c "$2"
}
# Fixture 1.0.6 posee sous le nom donne, a l'uid 1000.
poser_fixture() {
  aide "$1" "cat > /d/$2 && chown 1000:1000 /d/$2" < "$FIXTURE"
}
# La migration, options de CockpitTls.ps1 ; utilisateur 1000:1000 sauf demande. Ligne dans $OUT, code dans $CODE.
lancer() {
  local user="${2:-1000:1000}"
  SEQ=$((SEQ + 1))
  set +e
  timeout 120 docker run --rm --pull never --name "$PREFIX-run-$SEQ" --network none --user "$user" --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 32 -v "$1:/oc-config" --entrypoint node "$IMAGE" \
    --no-warnings server/migrate-oc-config.ts /oc-config >"$WORK/out" 2>"$WORK/err"
  CODE=$?
  set -e
  OUT="$(tr -d '\r' < "$WORK/out")"
}
ligne() {
  # ligne <etat> <profil> <fichier> <blocs> <restes> <sauvegarde> <raison>
  printf 'migration-web etat=%s profil=%s fichier=%s blocs=%s restes=%s sauvegarde=%s raison=%s' "$@"
}
lire() { aide "$1" "cat /d/$2" > "$3"; }
mode_de() { aide "$1" "stat -c %a /d/$2" | tr -d '\r\n'; }
empreinte() { aide "$1" "sha256sum /d/$2 | cut -d ' ' -f 1" | tr -d '\r\n'; }
est_lien() { aide "$1" "if [ -L /d/$2 ]; then echo lien; else echo autre; fi" | tr -d '\r\n'; }

if [ ! -f "$FIXTURE" ]; then
  echo "Fixture absente : $FIXTURE" >&2
  exit 2
fi
sed -e 's/"webfetch": "ask"/"webfetch": "deny"/' -e 's/"websearch": "ask"/"websearch": "deny"/' "$FIXTURE" > "$WORK/attendu"

say "Fichier livre de la 1.0.0 a la 1.0.6 : migre, puis conforme a la relance ; --read-only et --user 1000:1000 suffisent"
nouveau_volume
V1="$VOL"
poser_fixture "$V1" opencode.jsonc
MODE_AVANT="$(mode_de "$V1" opencode.jsonc)"
lancer "$V1"
check "$(ligne migre prudent opencode.jsonc 1 0 opencode.jsonc.avant-1.1.0 -)" "$OUT" "premier passage : ligne exacte"
check 0 "$CODE" "premier passage : code 0"
check "" "$(tr -d '\r\n' < "$WORK/err")" "premier passage : stderr vide"
lire "$V1" opencode.jsonc "$WORK/apres"
if cmp -s "$WORK/attendu" "$WORK/apres"; then ok "fichier migre a l'octet (deux jetons ask -> deny)"; else ko "fichier migre different de l'attendu"; fi
lire "$V1" opencode.jsonc.avant-1.1.0 "$WORK/copie"
if cmp -s "$FIXTURE" "$WORK/copie"; then ok "copie opencode.jsonc.avant-1.1.0 = fichier d'origine"; else ko "copie differente de l'original"; fi
check "$MODE_AVANT" "$(mode_de "$V1" opencode.jsonc)" "mode d'origine garde ($MODE_AVANT)"
check "opencode.jsonc opencode.jsonc.avant-1.1.0" "$(aide "$V1" 'ls -A /d' | tr -d '\r' | tr '\n' ' ' | sed 's/ $//')" "aucun temporaire laisse"
EMPREINTE="$(empreinte "$V1" opencode.jsonc)"
lancer "$V1"
check "$(ligne conforme - opencode.jsonc 0 0 - -)" "$OUT" "second passage : conforme"
check "$EMPREINTE" "$(empreinte "$V1" opencode.jsonc)" "second passage : fichier inchange"

say "Volume neuf : absent, rien d'ecrit"
nouveau_volume
lancer "$VOL"
check "$(ligne absent - - 0 0 - -)" "$OUT" "volume vide : absent"
check "" "$(aide "$VOL" 'ls -A /d' | tr -d '\r\n')" "volume vide : rien d'ecrit"

say "Lien symbolique au nom du fichier : jamais suivi"
nouveau_volume
aide "$VOL" "cat > /d/vrai.jsonc && ln -s /d/vrai.jsonc /d/opencode.jsonc && chown -h 1000:1000 /d/vrai.jsonc /d/opencode.jsonc" < "$FIXTURE"
lancer "$VOL"
check "$(ligne non-migre - opencode.jsonc 0 0 - lien-ou-special)" "$OUT" "lien vers un fichier du dossier : lien-ou-special"
check "lien" "$(est_lien "$VOL" opencode.jsonc)" "le lien reste un lien"
lire "$VOL" vrai.jsonc "$WORK/vrai"
if cmp -s "$FIXTURE" "$WORK/vrai"; then ok "cible du lien intacte"; else ko "cible du lien modifiee"; fi
nouveau_volume
aide "$VOL" "ln -s /app/package.json /d/opencode.jsonc && chown -h 1000:1000 /d/opencode.jsonc"
lancer "$VOL"
check "$(ligne non-migre - opencode.jsonc 0 0 - lien-ou-special)" "$OUT" "lien vers un fichier hors du dossier : lien-ou-special"

say "Lien au nom de la sauvegarde : jamais suivi, rien d'ecrit"
nouveau_volume
poser_fixture "$VOL" opencode.jsonc
aide "$VOL" "printf 'piege' > /d/piege && ln -s /d/piege /d/opencode.jsonc.avant-1.1.0 && chown -h 1000:1000 /d/piege /d/opencode.jsonc.avant-1.1.0"
lancer "$VOL"
check "$(ligne non-migre prudent opencode.jsonc 0 0 - sauvegarde-impossible)" "$OUT" "lien au nom de la sauvegarde : sauvegarde-impossible"
check "piege" "$(aide "$VOL" 'cat /d/piege')" "cible du lien intacte"
lire "$VOL" opencode.jsonc "$WORK/intact"
if cmp -s "$FIXTURE" "$WORK/intact"; then ok "fichier de configuration intact"; else ko "fichier de configuration modifie"; fi
nouveau_volume
aide "$VOL" "cat > /d/opencode.json && ln -s /d/cree-par-le-lien /d/opencode.json.avant-1.1.0 && chown -h 1000:1000 /d/opencode.json /d/opencode.json.avant-1.1.0" < "$FIXTURE"
lancer "$VOL"
check "$(ligne non-migre prudent opencode.json 0 0 - sauvegarde-impossible)" "$OUT" "lien pendant au nom de la sauvegarde : sauvegarde-impossible"
check "absent" "$(aide "$VOL" 'if [ -e /d/cree-par-le-lien ]; then echo present; else echo absent; fi' | tr -d '\r\n')" "rien de cree a travers le lien"

say "Tube (FIFO) au nom du fichier : refuse sans blocage"
nouveau_volume
aide "$VOL" "mkfifo /d/opencode.jsonc && chown 1000:1000 /d/opencode.jsonc"
lancer "$VOL"
check "$(ligne non-migre - opencode.jsonc 0 0 - lien-ou-special)" "$OUT" "FIFO : lien-ou-special, sans attendre le delai"

say "Dossier en 0555 : copie impossible, rien d'ecrit"
nouveau_volume
poser_fixture "$VOL" opencode.jsonc
aide "$VOL" "chmod 0555 /d"
lancer "$VOL"
check "$(ligne non-migre prudent opencode.jsonc 0 0 - sauvegarde-impossible)" "$OUT" "dossier en 0555 : sauvegarde-impossible"
lire "$VOL" opencode.jsonc "$WORK/lecture-seule"
if cmp -s "$FIXTURE" "$WORK/lecture-seule"; then ok "fichier intact"; else ko "fichier modifie dans un dossier en lecture seule"; fi

say "Fichier en 0600 : mode garde"
nouveau_volume
poser_fixture "$VOL" opencode.jsonc
aide "$VOL" "chmod 0600 /d/opencode.jsonc"
lancer "$VOL"
check "$(ligne migre prudent opencode.jsonc 1 0 opencode.jsonc.avant-1.1.0 -)" "$OUT" "fichier en 0600 : migre"
check 600 "$(mode_de "$VOL" opencode.jsonc)" "fichier : mode 0600 garde"
check 600 "$(mode_de "$VOL" opencode.jsonc.avant-1.1.0)" "copie : mode 0600"

say "Lancement en root : refuse"
nouveau_volume
poser_fixture "$VOL" opencode.jsonc
lancer "$VOL" 0
check "$(ligne erreur - - 0 0 - root)" "$OUT" "--user 0 : erreur root"
check 1 "$CODE" "--user 0 : code 1"
lire "$VOL" opencode.jsonc "$WORK/root"
if cmp -s "$FIXTURE" "$WORK/root"; then ok "fichier intact"; else ko "fichier modifie en root"; fi

if [ "$FAILURES" -gt 0 ]; then
  printf '\n== Migration du web : %s echec(s)\n' "$FAILURES" >&2
  exit 1
fi
printf '\n== Migration du web : tous les cas sont verts\n'
