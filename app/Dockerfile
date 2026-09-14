# syntax=docker/dockerfile:1
# Image « app » d'opencode-cockpit : serveur Node (TypeScript exécuté nativement) + interface web construite.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

FROM ${NODE_IMAGE} AS build
# Proxy d'entreprise : HTTP_PROXY, HTTPS_PROXY et NO_PROXY sont des arguments prédéfinis de Docker, transmis aux étapes
# RUN sans être déclarés ; les déclarer (ARG) inscrirait leur valeur, identifiants compris, dans l'historique.
ARG COCKPIT_TLS_INSECURE=0
WORKDIR /src

# Certificats d'entreprise facultatifs pour npm derrière un proxy TLS.
COPY certs/ /tmp/cockpit-certs/
RUN set -eu; : > /tmp/extra-ca.pem; \
    for f in /tmp/cockpit-certs/*.pem /tmp/cockpit-certs/*.crt; do \
      [ -f "$f" ] && grep -q 'BEGIN CERTIFICATE' "$f" && { cat "$f"; echo; } >> /tmp/extra-ca.pem || true; \
    done

COPY app/package.json app/package-lock.json ./
RUN set -eu; \
    if [ -s /tmp/extra-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; fi; \
    if [ "$COCKPIT_TLS_INSECURE" = "1" ]; then export npm_config_strict_ssl=false; fi; \
    npm ci --ignore-scripts --no-audit --no-fund

COPY app/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

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
    COCKPIT_WORKSPACE_DIR=/workspace
WORKDIR /app
COPY --from=build --chown=node:node /src/package.json ./package.json
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/server ./server
COPY --from=build --chown=node:node /src/dist ./dist
# Les points de montage partagés avec opencode doivent appartenir à l'utilisateur non-root (uid 1000) :
# Docker initialise un volume nommé avec le propriétaire du dossier de la PREMIÈRE image qui le monte.
RUN rm -f server/*.test.ts \
 && mkdir -p /data /archives /oc-config /oc-data /control /workspace /certs \
 && chown node:node /data /archives /oc-config /oc-data /control
USER node
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7777/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
