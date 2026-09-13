# syntax=docker/dockerfile:1
# Image « opencode » d'opencode-cockpit : opencode épinglé, git, ripgrep, utilisateur non-root.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
FROM ${NODE_IMAGE}

ARG OPENCODE_VERSION=1.18.30
# Proxy d'entreprise éventuel pendant la construction.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
# 1 = construction sans vérification TLS (secours uniquement, voir certs/README.md).
ARG COCKPIT_TLS_INSECURE=0

ENV DEBIAN_FRONTEND=noninteractive

# Autorités de certification d'entreprise facultatives (certs/*.pem|*.crt).
COPY certs/ /tmp/cockpit-certs/

# Les dépôts Debian de l'image passent en HTTP : apt fonctionne derrière un proxy TLS.
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git less openssh-client procps ripgrep tini; \
    rm -rf /var/lib/apt/lists/*; \
    n=0; \
    for f in /tmp/cockpit-certs/*.pem /tmp/cockpit-certs/*.crt; do \
      [ -f "$f" ] || continue; \
      if grep -q 'BEGIN CERTIFICATE' "$f"; then n=$((n + 1)); cp "$f" "/usr/local/share/ca-certificates/cockpit-$n.crt"; fi; \
    done; \
    update-ca-certificates; \
    rm -rf /tmp/cockpit-certs

# opencode épinglé ; la variante « baseline » tourne aussi sur les processeurs sans AVX2 (VM).
RUN set -eu; \
    if [ "$COCKPIT_TLS_INSECURE" = "1" ]; then export npm_config_strict_ssl=false; fi; \
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; \
    npm install -g --no-fund --no-audit "opencode-ai@${OPENCODE_VERSION}"; \
    root="$(npm root -g)/opencode-ai"; \
    arch="$(dpkg --print-architecture)"; \
    if [ "$arch" = "amd64" ] && [ -x "$root/node_modules/opencode-linux-x64-baseline/bin/opencode" ]; then \
      ln -sf "$root/node_modules/opencode-linux-x64-baseline/bin/opencode" /usr/local/bin/opencode; \
    else \
      ln -sf "$root/bin/opencode.exe" /usr/local/bin/opencode; \
    fi; \
    opencode --version; \
    npm cache clean --force

# Git : les dépôts Windows montés appartiennent à un autre utilisateur et utilisent CRLF.
RUN git config --system safe.directory '*' \
 && git config --system core.autocrlf true \
 && git config --system init.defaultBranch main

COPY docker/opencode/entrypoint.sh /usr/local/bin/cockpit-opencode-entrypoint
COPY docker/opencode/healthcheck.sh /usr/local/bin/cockpit-healthcheck
COPY docker/opencode/opencode.default.jsonc /usr/local/share/cockpit/opencode.default.jsonc

RUN chmod 0755 /usr/local/bin/cockpit-opencode-entrypoint /usr/local/bin/cockpit-healthcheck \
 && mkdir -p /workspace /control /certs \
      /home/node/.config/opencode/agents /home/node/.config/opencode/commands /home/node/.config/opencode/skills \
      /home/node/.local/share/opencode /home/node/.cache/opencode /home/node/.cockpit \
 && chown -R node:node /workspace /control /home/node

USER node
WORKDIR /workspace
ENV HOME=/home/node \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
    OPENCODE_DISABLE_CLAUDE_CODE=1

EXPOSE 4096
HEALTHCHECK --interval=10s --timeout=6s --start-period=30s --retries=12 CMD ["cockpit-healthcheck"]
ENTRYPOINT ["tini", "--", "cockpit-opencode-entrypoint"]
