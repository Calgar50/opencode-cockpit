#!/bin/sh
# Faux opencode des tests conteneur de L17a. JAMAIS le vrai opencode, jamais l'extension : ces tests verifient le superviseur,
# pas l'IA. Pose dans le conteneur sous le nom "opencode", dans un dossier place avant /usr/local/bin dans le PATH.
#
# Il fait trois choses :
#   1. il ecrit ses capacites (/proc/self/status) et son identite dans le dossier de donnees, la ou le test les relit : c'est la
#      preuve que le superviseur l'a bien lance en tant que node, avec CapEff, CapPrm, CapInh et CapAmb a 0 (M32) ;
#   2. il boucle, comme un serveur ;
#   3. avec OMO_STUB_TETU=1 (variable de TEST, lue par ce faux seulement), il ignore TERM : la boucle de l'homme mort doit alors
#      aller jusqu'au KILL, et l'arret rester sous la borne des 27 s.
set -u

SORTIE="${HOME:-/home/node}/.local/share/opencode/omo-stub-capacites.txt"

mkdir -p "$(dirname "$SORTIE")" 2>/dev/null || true
{
  printf 'argv: %s\n' "$*"
  printf 'pwd: %s\n' "$(pwd)"
  printf 'home: %s\n' "${HOME:-}"
  id 2>/dev/null || true
  grep -E '^(Uid|Gid|Groups|NoNewPrivs|Cap(Inh|Prm|Eff|Bnd|Amb)):' /proc/self/status 2>/dev/null || true
} > "$SORTIE.tmp" 2>&1 || true
mv -f "$SORTIE.tmp" "$SORTIE" 2>/dev/null || true

if [ "${OMO_STUB_TETU:-0}" = "1" ]; then
  trap '' TERM INT
else
  trap 'exit 0' TERM INT
fi

while true; do
  sleep 1
done
