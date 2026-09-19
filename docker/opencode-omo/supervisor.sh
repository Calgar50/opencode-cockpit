#!/bin/sh
# Superviseur de la Salle OMO : PID 1 sous tini (ou "docker run --init"), boucle et signaux SEULEMENT.
# Toute la logique est dans /opt/omo-check/supervisor-lib.mjs (D-2b-24) ; ce script ne lit que des codes de sortie.
# Fichier en ASCII pur : il tourne avec le shell de l'image, sans locale garantie.
#
# Ordre impose (plan 2 bis, fiche L17a ; spec. 3.15.2 l.499-517) :
#   1. manifeste compare a /etc/omo-reference/omo-manifest.sha256 (ecart ou amorce -> refus, D-2b-32) ;
#   2. node /opt/omo-check/validate.mjs (echec -> refus, G14) ;
#   3. cinq dossiers de configuration du HOME : a root, points de montage, node ne peut pas y ecrire (D-2b-33, MO-3) ; volumes
#      de la salle au proprietaire du contrat (MO-11), /control, /auth-src et /omo-state fermes a node (G9, M32) ; bascule vers
#      node verifiee sur le processus lui-meme : aucune capacite, aucun groupe, no-new-privileges (D-2b-27, MO-7) ;
#   4. EN TANT QUE node : purge de /tmp, du HOME et du dossier de donnees sauf opencode.db* (MO-2), copie d'auth.json en 0600 ;
#   5. EN TANT QUE node : etat des .git des projets prepares et balayage de /workspace (D-2b-28, MO-3) ;
#   6. publication de state.json (root) ;
#   7. attente d'un battement frais ET du precheck-ok de CE demarrage ;
#   8. points de montage figes, puis opencode lance par setpriv vers node ;
#   9. toutes les OMO_VERIFICATION_S secondes : stop-request, battement perime, point de montage deplace (MO-3) ou opencode
#      arrete -> TERM, KILL plus tard, sortie non nulle.
#
# Rien ne demarre sans battement : un "docker compose --profile omo up" lance a la main s'arrete a l'etape 7 (plan 2.7).
# Les etapes 3 (moitie node), 4 et 5 touchent des fichiers de node : elles passent par setpriv (D-2b-27) et n'ecrivent RIEN chez
# root. Elles rendent leur constat en JSON sur la sortie standard, que le superviseur (root) redirige vers son dossier de travail
# puis absorbe : node ne peut donc pas fausser l'etat publie.
# Capacites : root garde SETUID et SETGID pour setpriv ; apres setpriv, CapEff, CapPrm, CapInh et CapAmb valent 0 (verifie).
# "setpriv --bounding-set -all" n'est PAS utilise : sans CAP_SETPCAP il sort 0 sans rien changer (MO-7, mesure L17a) ; l'ensemble
# borne reste SETUID+SETGID, limite dite (R10).
set -eu

LIB=/opt/omo-check/supervisor-lib.mjs
VALIDATE=/opt/omo-check/validate.mjs
MANIFEST=/opt/omo-check/manifest.sh
ETAT_DIR=/omo-state
ETAPE="$ETAT_DIR/.etape.json"
MANIFESTE_ACTUEL="$ETAT_DIR/.manifeste-actuel.txt"
WORKSPACE=/workspace
# Port fixe : la liste blanche de variables de la salle (contrat) n'en porte aucune, rien d'exterieur ne doit le decider.
PORT=4096

# Delais de D-2b-25 : valeurs de secours, remplacees plus bas par celles de la bibliotheque (source unique).
OMO_BATTEMENT_S=5
OMO_VERIFICATION_S=2
OMO_KILL_APRES_S=3

enfant=0
arret_signal=0
CODE=0

log() {
  printf '%s omo-supervisor: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

# Code de sortie d'une commande dans CODE, sans que "set -e" arrete le script.
executer() {
  set +e
  "$@"
  CODE=$?
  set -e
}

# Refus : rien ne demarre. L'etat est publie pour que le cockpit dise POURQUOI, puis sortie non nulle.
refus() {
  log "REFUS: $1"
  node "$LIB" publier arret || true
  exit 2
}

# Signal a opencode, EN TANT QUE node. Root n'a pas CAP_KILL (cap_drop: ALL, seulement SETUID et SETGID) : un "kill" de root
# vers un processus de node echoue en EPERM (mesure L17a). node, lui, peut signaler ses propres processus.
signal_enfant() {
  if [ "$enfant" -ne 0 ]; then
    # shellcheck disable=SC2086
    $SETPRIV sh -c 'kill -s "$1" "$2"' omo-signal "$1" "$enfant" 2>/dev/null || true
  fi
}

# Signaux recus par le superviseur : le conteneur s'arrete proprement, sans attendre la fin de la boucle.
on_term() {
  arret_signal=1
  signal_enfant TERM
}

# TERM, puis KILL OMO_KILL_APRES_S secondes plus tard (D-2b-25). Jamais de "wait" sans borne : si un signal n'a pas pu partir,
# la sortie du superviseur (PID 1 sous tini) fait tomber tout le conteneur, opencode compris. C'est la garantie de dernier recours.
arreter_enfant() {
  if [ "$enfant" -eq 0 ]; then
    return 0
  fi
  signal_enfant TERM
  i=0
  while [ "$i" -lt "$OMO_KILL_APRES_S" ] && node "$LIB" vivant "$enfant"; do
    sleep 1
    i=$((i + 1))
  done
  if [ "$i" -ge "$OMO_KILL_APRES_S" ]; then
    log "opencode toujours la ${OMO_KILL_APRES_S} s apres TERM : KILL"
  fi
  signal_enfant KILL
  enfant=0
}

# --- Etape 0 : outils indispensables ---------------------------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || { log "REFUS: node absent"; exit 2; }
command -v setpriv >/dev/null 2>&1 || { log "REFUS: setpriv absent"; exit 2; }
[ -f "$LIB" ] || { log "REFUS: bibliotheque du superviseur absente"; exit 2; }
[ -d "$ETAT_DIR" ] || { log "REFUS: volume d'etat absent"; exit 2; }

# Non quote a l'usage : c'est une commande et ses options, pas un seul mot.
SETPRIV="setpriv --reuid node --regid node --clear-groups --inh-caps -all"

# setpriv garde l'environnement du pere : sans cette ligne, opencode partirait sur le HOME de root (/root) et n'irait jamais
# chercher les cinq dossiers de configuration montes en lecture seule (D-2b-33). HOME decide de tout, il est pose ici.
HOME=/home/node
USER=node
LOGNAME=node
export HOME USER LOGNAME

node "$LIB" init || { log "REFUS: dossier de travail du superviseur non ecrit"; exit 2; }
trap on_term TERM INT
log "demarrage"

# --- Etape 1 : manifeste (D-2b-32) -----------------------------------------------------------------------------------------------
[ -x "$MANIFEST" ] || refus "calcul du manifeste absent"
executer "$MANIFEST" > "$MANIFESTE_ACTUEL"
[ "$CODE" -eq 0 ] || refus "calcul du manifeste en echec"
executer node "$LIB" manifeste "$MANIFESTE_ACTUEL"
[ "$CODE" -eq 0 ] || refus "manifeste different de la reference de l'image (ecart ou amorce)"
log "manifeste conforme a la reference de l'image"

# --- Etape 2 : validation de la configuration (JS-5, G14) -------------------------------------------------------------------------
[ -f "$VALIDATE" ] || refus "validateur absent"
executer node "$VALIDATE"
code_valide="$CODE"
executer node "$LIB" validation "$code_valide"
[ "$CODE" -eq 0 ] || refus "validation de la configuration en echec"
log "configuration validee"

# Delais de la bibliotheque : "NOM=<chiffres>" seulement, produits par notre propre module, deja verifie par le manifeste.
delais="$(node "$LIB" delais-sh)" || refus "delais du superviseur illisibles"
eval "$delais"

# --- Etape 3 : dossiers de configuration du HOME, volumes, bascule vers node (D-2b-33, MO-3, MO-7, MO-11) -------------------------
executer node "$LIB" config-root
[ "$CODE" -eq 0 ] || refus "un dossier de configuration manque, n'est pas un dossier, n'appartient pas a root ou n'est plus un point de montage"
executer node "$LIB" volumes-root
[ "$CODE" -eq 0 ] || refus "un volume de la salle manque, n'est pas un point de montage ou n'a pas le proprietaire du contrat"
# shellcheck disable=SC2086
executer $SETPRIV node "$LIB" capacites
[ "$CODE" -eq 0 ] || refus "bascule vers node incomplete : capacite, groupe ou no-new-privileges"
log "bascule vers node verifiee : aucune capacite effective, permise, heritable ni ambiante"
# shellcheck disable=SC2086
executer $SETPRIV node "$LIB" config-node > "$ETAPE"
code_config="$CODE"
executer node "$LIB" absorber "$ETAPE"
[ "$code_config" -eq 0 ] || refus "un dossier de configuration ou un volume de controle est inscriptible par node"
[ "$CODE" -eq 0 ] || refus "constat des dossiers de configuration refuse"
log "cinq dossiers de configuration et volumes de controle en lecture seule"

# --- Etapes 4 et 5 : purge, auth.json, .git des projets, balayage de /workspace (D-2b-27, D-2b-28, D-2b-36) -----------------------
# Un .git inscriptible ou un balayage incomplet n'est PAS un refus ici : D-2b-28 partage les roles, le superviseur publie l'etat et
# le cockpit refuse l'activation. Le superviseur, lui, ne se declarera jamais pret (etape 7) tant que ce n'est pas propre.
# shellcheck disable=SC2086
executer $SETPRIV node "$LIB" preparation > "$ETAPE"
code_preparation="$CODE"
executer node "$LIB" absorber "$ETAPE"
[ "$CODE" -eq 0 ] || refus "constat de preparation illisible"
if [ "$code_preparation" -ne 0 ]; then
  log "ATTENTION: dossier de travail non protege (un .git inscriptible ou hors montage, ou balayage incomplet) : rien ne demarrera"
fi
log "purge faite, auth.json pose, dossier de travail balaye"

# --- Etape 6 : publication de l'etat ----------------------------------------------------------------------------------------------
node "$LIB" publier attente || refus "etat non publie"

# --- Etape 7 : attente du battement et du precheck-ok de CE demarrage -------------------------------------------------------------
log "attente d'un battement frais et du precheck-ok du demarrage en cours"
while [ "$arret_signal" -eq 0 ]; do
  executer node "$LIB" pret
  if [ "$CODE" -eq 0 ]; then
    break
  fi
  if [ "$CODE" -ge 10 ]; then
    log "arret demande pendant l'attente"
    node "$LIB" publier arret || true
    exit 3
  fi
  sleep "$OMO_BATTEMENT_S"
done
if [ "$arret_signal" -ne 0 ]; then
  node "$LIB" publier arret || true
  log "arret demande avant le lancement"
  exit 0
fi
log "battement et precheck-ok recus"

# --- Etape 8 : opencode, en tant que node ------------------------------------------------------------------------------------------
cd "$WORKSPACE" || refus "dossier de travail absent"
# La vue des montages que la boucle defendra : figee AVANT le lancement, quand rien ne tourne encore en tant que node (MO-3).
node "$LIB" figer-montages || refus "table des points de montage illisible"
node "$LIB" publier opencode-lance || refus "etat non publie"
# shellcheck disable=SC2086
$SETPRIV opencode serve --hostname 0.0.0.0 --port "$PORT" --print-logs --log-level INFO &
enfant=$!
log "opencode lance (pid $enfant)"

# --- Etape 9 : homme mort ----------------------------------------------------------------------------------------------------------
# Code 10 : stop-request ; 11 : battement perime ; 12 : opencode n'est plus la ; 13 : point de montage deplace (MO-3). Tous mettent
# fin au conteneur, sortie non nulle.
sortie=0
while [ "$arret_signal" -eq 0 ]; do
  executer node "$LIB" verifier "$enfant"
  if [ "$CODE" -ne 0 ]; then
    log "fin de la salle (code $CODE : 10 arret demande, 11 battement perime, 12 opencode arrete, 13 point de montage deplace)"
    sortie="$CODE"
    break
  fi
  sleep "$OMO_VERIFICATION_S"
done

arreter_enfant
node "$LIB" publier arret || true
log "fin du superviseur (code $sortie)"
exit "$sortie"
