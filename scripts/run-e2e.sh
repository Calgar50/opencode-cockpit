#!/usr/bin/env bash
# Banc e2e du cockpit (paquet L7a). Aucune dépendance : Node 24 (fetch et WebSocket natifs), Docker, et un navigateur
# Edge ou Chromium piloté par CDP. Rien de tout cela ne tourne en intégration continue (décision D-06).
#
# Usage :
#   scripts/run-e2e.sh [--faux | --reel-hors-ligne | --reel] [--http] [options]
#
# Modes :
#   --faux              cockpit + faux opencode (défaut) ; aucune IA, aucun appel facturé
#   --reel-hors-ligne   cockpit + vrai opencode 1.18.30 + faux fournisseur ; aucun appel facturé
#                       (demande la mesure M-B1, conclue positive dans execution/mesures/MX1.md)
#   --reel              cockpit + vrai opencode avec une IA réelle : APPELS FACTURÉS, sur accord explicite
#
# Accès au cockpit (R105b) : HTTPS épinglé par défaut, comme une installation 1.0.5. Le certificat public est lu sur
# le volume de la pile jetable, puis seul ce certificat est accepté (Node et navigateur) ; la vérification TLS n'est
# jamais coupée. Connexion par ticket (défi signé sur /api/health, puis /auth?k=), comme « cockpit.ps1 open ».
#   --http                   mode HTTP explicite de la 1.0.5 (COCKPIT_LOCAL_SCHEME=http, date de confirmation)
#
# Options :
#   --scenarios <motif>      ne lance que les scénarios dont le nom correspond (sous-chaîne ou « it1-* »)
#   --project-prefix <nom>   préfixe du projet Docker et des images (défaut : cockpit-e2e)
#   --image-tag <étiquette>  étiquette des images bâties (défaut : local)
#   --salle                  pile de la Salle OMO FACTICE (L26c, « --faux » seulement) : scénarios omo-ui-* seuls
#   --fichier-env <chemin>   fichier d'environnement de la pile jetable (défaut : sous le dossier temporaire du banc)
#   --dry-run                affiche les commandes docker sans les exécuter
#   --garder-pile            laisse la pile debout après l'exécution (pour regarder un échec)
#   --gardes                 vérifie les refus d'isolation, sans Docker ni navigateur
#   --help                   cette aide
#
# Code de sortie : nombre de scénarios en échec (0 = aucun), ou 1 si le banc refuse de démarrer.
#
# Isolation (fiche L7a) : projet Docker propre au banc, images <préfixe>/app et <préfixe>/opencode bâties depuis les
# sources, volumes jetables, port libre différent de 7777, mot de passe et jeton fabriqués à chaque exécution et
# jamais affichés. Le banc refuse de démarrer si le projet résolu désigne la pile de l'utilisateur, si le fichier
# d'environnement est un .env, ou si une exécution réelle tient déjà le verrou.
set -euo pipefail

racine="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$racine"

# MSYS_NO_PATHCONV : sous Git Bash, MSYS convertirait « /workspace » en chemin Windows dans les arguments de docker.
export MSYS_NO_PATHCONV=1

aide() {
  sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

gardes_seules=0
for argument in "$@"; do
  case "$argument" in
    --help | -h)
      aide
      exit 0
      ;;
    --gardes) gardes_seules=1 ;;
  esac
done

if ! command -v node > /dev/null 2>&1; then
  echo "Banc e2e : Node est introuvable (Node 24 ou plus récent est exigé)." >&2
  exit 1
fi
version_node="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$version_node" -lt 24 ]; then
  echo "Banc e2e : Node $version_node est trop ancien (24 ou plus récent ; fetch et WebSocket natifs)." >&2
  exit 1
fi

if [ "$gardes_seules" -eq 0 ] && ! command -v docker > /dev/null 2>&1; then
  echo "Banc e2e : Docker est introuvable." >&2
  exit 1
fi

exec node --disable-warning=ExperimentalWarning e2e/lib/docker-e2e.mjs "$@"
