# syntax=docker/dockerfile:1
# Image « app » d'opencode-cockpit : serveur Node (TypeScript exécuté nativement) + interface web construite.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

FROM ${NODE_IMAGE} AS build
# Proxy d'entreprise : HTTP_PROXY, HTTPS_PROXY et NO_PROXY sont des arguments prédéfinis de Docker, transmis aux étapes
# RUN sans être déclarés ; les déclarer (ARG) inscrirait leur valeur, identifiants compris, dans l'historique.
ARG COCKPIT_TLS_INSECURE=0
WORKDIR /src

COPY app/package.json app/package-lock.json ./
# Autorités de certification d'entreprise facultatives (certs/*.pem|*.crt) pour npm derrière un proxy TLS : montées le temps
# de cette étape seulement. Aucune couche ne garde le dossier certs/, et seuls les blocs CERTIFICATE en sont extraits :
# une clé privée déposée par erreur dans certs/ n'entre ni dans l'image, ni dans /tmp/extra-ca.pem.
RUN --mount=type=bind,source=certs,target=/tmp/cockpit-certs \
    set -eu; \
    : > /tmp/extra-ca.pem; \
    for f in /tmp/cockpit-certs/*.pem /tmp/cockpit-certs/*.crt; do \
      [ -f "$f" ] || continue; \
      if grep -q 'BEGIN CERTIFICATE' "$f"; then \
        sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' "$f" >> /tmp/extra-ca.pem; \
        echo >> /tmp/extra-ca.pem; \
      fi; \
    done; \
    if [ -s /tmp/extra-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; fi; \
    if [ "$COCKPIT_TLS_INSECURE" = "1" ]; then export npm_config_strict_ssl=false; fi; \
    npm ci --ignore-scripts --no-audit --no-fund

COPY app/ ./
# Tests, faux opencode et captures retirés ici, avant la copie vers l'image finale : une suppression dans l'image finale les
# laisserait dans la couche copiée.
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf server/test-support && find server -name '*.test.ts' -delete

FROM ${NODE_IMAGE}
ARG COCKPIT_VERSION=dev
ENV COCKPIT_VERSION=${COCKPIT_VERSION} \
    NODE_ENV=production \
    COCKPIT_WEB_DIR=/app/dist/web \
    COCKPIT_DATA_DIR=/data \
    COCKPIT_ARCHIVE_DIR=/archives \
    COCKPIT_OC_CONFIG_DIR=/oc-config \
    COCKPIT_OC_DATA_DIR=/oc-data \
    COCKPIT_CONTROL_DIR=/control \
    COCKPIT_WORKSPACE_DIR=/workspace \
    COCKPIT_TLS_DIR=/tls \
    COCKPIT_OPENSSL=/usr/bin/openssl
# openssl : seule façon de créer le certificat du HTTPS local (execFile, chemin absolu, jamais de shell). Node embarque sa
# propre bibliothèque TLS mais pas l'outil en ligne de commande. OpenSSL 3 exigé : les options -addext et -pkeyopt utilisées
# par le serveur n'ont pas le même comportement en 1.x. Listes apt supprimées dans la même couche.
RUN set -eu; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssl; \
    rm -rf /var/lib/apt/lists/*; \
    /usr/bin/openssl version | grep -q '^OpenSSL 3\.'
WORKDIR /app
COPY --from=build --chown=node:node /src/package.json ./package.json
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/server ./server
COPY --from=build --chown=node:node /src/dist ./dist
# Les points de montage partagés avec opencode doivent appartenir à l'utilisateur non-root (uid 1000) :
# Docker initialise un volume nommé avec le propriétaire du dossier de la PREMIÈRE image qui le monte.
# /tls est monté par ce seul service : 0700 à node, pour que la clé du HTTPS local n'y soit jamais lisible par d'autres.
# Les tests sont déjà retirés à l'étape de build (voir plus haut).
RUN mkdir -p /data /archives /oc-config /oc-data /control /workspace /certs /tls \
 && chown node:node /data /archives /oc-config /oc-data /control /tls \
 && chmod 0700 /tls
USER node
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "--disable-warning=ExperimentalWarning", "server/healthcheck.ts"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
