# Image « opencode-omo » de la Salle OMO (spéc. §3.15.1 ; plan, fiche L15a) : l'image opencode du cockpit, plus Oh My OpenAgent
# 4.19.4 installé sans aucun script, ses deux fichiers de configuration en lecture seule et le superviseur (homme mort,
# manifeste, validation). Des deux fichiers, un seul est APPLIQUÉ par la 4.19.4 : opencode.jsonc, la configuration d'instance.
# omo.jsonc, la couche utilisateur, est posée, validée et couverte par le manifeste, mais l'extension ne s'en sert pas (mesuré
# deux fois par le banc, porte G2) : voir l'en-tête d'omo.jsonc et celui du filet guard/cockpit-guard.js, qui porte les coupures.
#
# JAMAIS construite ni publiée par la CI (P13) : construite sur le PC personnel par scripts/build-omo-image.ps1, contexte de
# construction = ce dossier (docker/opencode-omo), puis apportée au travail en archive (install.ps1 -OmoArchive, mode Load).
#
# Chemins de l'image : ceux du contrat contrat-salle.json (cheminsImage), égalité vérifiée par app/server/omo-image.test.ts.
#
# Aucune directive « syntax » (train de V1) : elle ferait tirer à chaque construction une image de frontal BuildKit NON épinglée
# par empreinte ; ce fichier n'utilise que des instructions du frontal intégré au moteur (ARG, FROM, COPY, RUN, ENV, USER).

# Image opencode du cockpit, épinglée par empreinte : <image>@sha256:<64 hexadécimaux>, sans valeur par défaut.
ARG OPENCODE_BASE
FROM ${OPENCODE_BASE}
ARG OPENCODE_BASE

USER root
WORKDIR /

# Base vérifiée avant tout : empreinte exigée ; utilisateur node d'uid et gid 1000 (image node officielle : le superviseur et le
# contrat le supposent) ; outils du superviseur présents (tini, setpriv, node, find et sha256sum de GNU).
RUN set -eu; \
    case "$OPENCODE_BASE" in \
      *@sha256:*) ;; \
      *) echo "OPENCODE_BASE doit être épinglée par empreinte : <image>@sha256:<64 hexadécimaux>" >&2; exit 1 ;; \
    esac; \
    printf '%s' "${OPENCODE_BASE##*@sha256:}" | grep -Eq '^[0-9a-f]{64}$' \
      || { echo "OPENCODE_BASE : empreinte sha256 invalide" >&2; exit 1; }; \
    test "$(id -u node)" = 1000 && test "$(id -g node)" = 1000 \
      || { echo "utilisateur node attendu en uid et gid 1000" >&2; exit 1; }; \
    for outil in tini setpriv node npm find sha256sum sed sort; do \
      command -v "$outil" > /dev/null || { echo "outil absent de l'image de base : $outil" >&2; exit 1; }; \
    done

# Extension : npm ci contre le lockfile versionné (intégrité SHA-512 de chaque paquet vérifiée par npm), AUCUN script
# d'installation (postinstall.mjs de l'extension ne tourne pas), sans dépendance de développement. Puis /opt/omo passe à root
# et perd tout droit d'écriture ; l'avis de licence est copié dans l'image (G11). Cache npm hors de l'image.
# Base 1.0.6 ou plus récente (décision D7 a de la grande fusion) : son ENV porte npm_config_offline=true, qui ferait échouer ce
# npm ci sur place (cache vide). Neutralisé pour CETTE étape seulement, par export ; l'ENV final n'est jamais redéfini ici, et
# les drapeaux de la base (OPENCODE_DISABLE_MODELS_FETCH=1, npm hors ligne…) restent hérités par la salle à l'exécution.
COPY package.json package-lock.json /opt/omo/
RUN set -eu; \
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; \
    export npm_config_offline=false; \
    cd /opt/omo; \
    npm ci --ignore-scripts --no-audit --no-fund --omit=dev --cache /tmp/npm-cache; \
    rm -rf /tmp/npm-cache; \
    mkdir -p /usr/share/doc/oh-my-openagent; \
    cp /opt/omo/node_modules/oh-my-openagent/LICENSE.md /usr/share/doc/oh-my-openagent/LICENSE.md; \
    chown -R root:root /opt/omo /usr/share/doc/oh-my-openagent; \
    chmod -R a+rX,a-w /opt/omo /usr/share/doc/oh-my-openagent

# Les deux configurations, root, en lecture seule (OPENCODE_CONFIG_DIR). Le .gitignore est posé d'avance : opencode l'écrit
# sinon dans chaque dossier de configuration, et une écriture refusée par un système en lecture seule (EROFS) n'est pas un
# refus de droits qu'il sait ignorer (config.ts, ensureGitignore).
COPY opencode.jsonc /etc/opencode-omo/opencode.jsonc
COPY omo.jsonc /etc/opencode-omo/omo/omo.jsonc

# Superviseur, validateurs, énumérations, calcul du manifeste, filet du cockpit (L24) et référence du manifeste, aux chemins
# du contrat. La référence est HORS du périmètre du manifeste (D-2b-32) : L15a y commite une amorce, refusée par le
# superviseur ; le manifeste réel est écrit par build-omo-image.ps1 -AcceptManifest (L21).
COPY supervisor.sh /usr/local/bin/omo-supervisor
COPY supervisor-lib.mjs validate.mjs validate-core.mjs enums-4.19.4.json manifest.sh /opt/omo-check/
COPY guard/cockpit-guard.js /opt/omo-guard/cockpit-guard.js
COPY omo-manifest.sha256 /etc/omo-reference/omo-manifest.sha256

# Identifiant de construction, lu par le superviseur pour le Diagnostic (/etc/opencode-omo/image-id, dans le périmètre) :
# l'identifiant Docker de l'image ne peut pas s'y écrire (il dépend de ce fichier) ; ce sont donc les entrées de la
# construction, stables d'une construction à l'autre : version, empreinte de la base, empreinte du lockfile.
# Puis tout le périmètre passe à root, sans droit d'écriture.
RUN set -eu; \
    printf '%s\n' "# Pose par l'image : opencode ne l'ecrit pas (dossier en lecture seule)." > /etc/opencode-omo/.gitignore; \
    printf 'oh-my-openagent@4.19.4 base=sha256:%s lock=sha256:%s\n' \
      "${OPENCODE_BASE##*@sha256:}" "$(sha256sum /opt/omo/package-lock.json | cut -c1-64)" > /etc/opencode-omo/image-id; \
    chown -R root:root /etc/opencode-omo /opt/omo-check /opt/omo-guard /etc/omo-reference /usr/local/bin/omo-supervisor; \
    chmod -R a+rX,a-w /etc/opencode-omo /opt/omo-check /opt/omo-guard /etc/omo-reference; \
    chmod 0555 /usr/local/bin/omo-supervisor /opt/omo-check/manifest.sh

# Dossiers de configuration du HOME (D-2b-33) : VIDES et à root dans l'image. L'image de base en donne à node (agents,
# commands, skills) : ils sont retirés. Compose monte par-dessus, en lecture seule, le volume omo-config à root, que le
# superviseur (root) remplit à chaque démarrage par /omo-config avec omo.jsonc (copie de /etc/opencode-omo/omo/omo.jsonc, seul
# emplacement que la 4.19.4 lit : ~/.omo/omo.jsonc) et un .gitignore (révision du train de V1) ; il exige, pour chacun, un
# dossier à root, point de montage, portant ce contenu, non inscriptible par node.
RUN set -eu; \
    for d in /home/node/.config/opencode /home/node/.opencode /home/node/.omo /home/node/.claude /home/node/.agents; do \
      rm -rf "$d"; \
      mkdir -p "$d"; \
      chown root:root "$d"; \
      chmod 0755 "$d"; \
    done

# Variables de l'image (spéc. l.485).
#
# CLAUDE_CONFIG_DIR : sans elle, l'extension calcule ses dossiers de travail par `getClaudeConfigDir()`, qui rend `~/.claude` —
# l'un des CINQ dossiers de configuration montés en lecture seule (D-2b-33). Elle y crée `transcripts` et `todos` MÊME avec
# `claude_code.hooks: false`, et la salle meurt au premier envoi sur `EROFS: read-only file system, mkdir
# '/home/node/.claude/transcripts'` (défaut n° 2 mesuré par le banc hors ligne, L21 §3, porte G2). La valeur pointe donc hors
# des cinq dossiers, sous le tmpfs `/home/node/.local/state` que le compose donne à `node` (MO-3 point 8) ; posée ici, elle ne
# dépend d'aucune variable d'hôte. Hors du périmètre du manifeste (`perimetreManifeste` : contenus de fichiers) : la référence
# `omo-manifest.sha256` ne bouge pas.
ENV OMO_DISABLE_POSTHOG=1 \
    OMO_SEND_ANONYMOUS_TELEMETRY=0 \
    OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    GIT_EDITOR=: \
    GIT_PAGER=cat \
    OPENCODE_CONFIG_DIR=/etc/opencode-omo \
    CLAUDE_CONFIG_DIR=/home/node/.local/state/claude

# Validation de la configuration figée (G14) : un nom faux, une clé inconnue ou une valeur épinglée retirée font échouer la
# construction. Rien de l'extension n'est exécuté : son package.json et son dist sont lus comme du texte.
RUN node /opt/omo-check/validate.mjs --construction

# Le superviseur démarre root (manifeste, validation, état) et lance opencode en tant que node par setpriv (D-2b-27).
USER root
WORKDIR /workspace
ENTRYPOINT ["tini", "--", "/usr/local/bin/omo-supervisor"]
