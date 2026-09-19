#!/bin/sh
# Manifeste SHA-256 de l'image opencode-omo (D-2b-32). Calcule par le superviseur a chaque demarrage (etape 1, compare a
# /etc/omo-reference/omo-manifest.sha256) et par scripts/build-omo-image.ps1 (-AcceptManifest : deux constructions, manifeste
# identique exige).
#
# Perimetre : celui du contrat docker/opencode-omo/contrat-salle.json (perimetreManifeste), egalite verifiee par un test.
# La reference /etc/omo-reference/omo-manifest.sha256 est HORS du perimetre : elle ne peut pas se contenir elle-meme.
#
# Sortie triee (LC_ALL=C), sans date ni taille : deux constructions identiques donnent le meme texte.
#   <sha256>  <chemin>                                      un fichier ordinaire (format de sha256sum) ;
#   meta <type> <droits> <uid>:<gid> <chemin>[ -> <cible>]   chaque entree : d dossier, f fichier, l lien, autre lettre sinon.
# Les lignes "meta" rendent visibles un droit d'ecriture, un proprietaire autre que root, un lien ou une entree ajoutee.
#
# Ferme en cas de doute : un chemin du perimetre absent ou lien, un fichier illisible ou une erreur de find font sortir en
# erreur SANS rien ecrire sur la sortie standard (le superviseur refuse alors de demarrer).
#
# Fichier en ASCII pur, shell POSIX (dash de l'image) ; outils GNU de Debian : find -printf, sha256sum, sed, sort.
# --racine DOSSIER : tests seulement, manifeste d'une arborescence posee sous DOSSIER, ecrit avec les chemins de l'image.
# Le superviseur ne passe aucun argument.
set -eu
LC_ALL=C
export LC_ALL

PERIMETRE="/opt/omo /opt/omo-check /opt/omo-guard /etc/opencode-omo /usr/local/bin/omo-supervisor"

usage() {
  echo "manifest.sh: usage : manifest.sh [--racine DOSSIER]" >&2
  exit 2
}

racine=""
case "$#" in
  0) ;;
  2)
    [ "$1" = "--racine" ] && [ -n "$2" ] || usage
    racine="${2%/}"
    ;;
  *) usage ;;
esac

# Lignes d'une entree du perimetre. find part d'un chemin relatif ("." ou "./nom"), remplace ensuite par le chemin de
# l'image : les chemins du perimetre ne contiennent ni "#", ni "&", ni barre oblique inverse.
lignes_de() {
  chemin="$1"
  if [ -L "$racine$chemin" ]; then
    echo "manifest.sh: chemin du perimetre remplace par un lien : $chemin" >&2
    return 1
  fi
  if [ -d "$racine$chemin" ]; then
    dossier="$racine$chemin"
    depart="."
    prefixe="$chemin"
  elif [ -f "$racine$chemin" ]; then
    dossier="$racine$(dirname "$chemin")"
    depart="./$(basename "$chemin")"
    prefixe="$(dirname "$chemin")"
  else
    echo "manifest.sh: chemin du perimetre absent : $chemin" >&2
    return 1
  fi
  # "var=$(...) || return 1" : un echec de cd, de find ou de sha256sum (fichier illisible) arrete tout.
  empreintes="$(cd "$dossier" && find "$depart" -type f -exec sha256sum -- {} +)" || return 1
  meta="$(cd "$dossier" && find "$depart" \( -type l -printf 'meta %y %m %U:%G %p -> %l\n' \) -o -printf 'meta %y %m %U:%G %p\n')" || return 1
  # "  " (mode texte, Linux) ou " *" (mode binaire, d'autres systemes) : toujours ecrit "  ".
  if [ -n "$empreintes" ]; then
    printf '%s\n' "$empreintes" | sed 's#^\([0-9a-f]\{64\}\) [ *]\./#\1  '"$prefixe"'/#'
  fi
  printf '%s\n' "$meta" | sed -e 's#^\(meta [a-z] [0-7]* [0-9]*:[0-9]*\) \.$#\1 '"$prefixe"'#' \
    -e 's#^\(meta [a-z] [0-7]* [0-9]*:[0-9]*\) \./#\1 '"$prefixe"'/#'
}

sortie=""
for chemin in $PERIMETRE; do
  lignes="$(lignes_de "$chemin")" || exit 1
  sortie="$sortie
$lignes"
done

printf '%s\n' "$sortie" | sed '/^$/d' | sort
