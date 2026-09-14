# syntax=docker/dockerfile:1
# Image « opencode » d'opencode-cockpit : opencode épinglé, git, ripgrep, utilisateur non-root.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
FROM ${NODE_IMAGE}

ARG OPENCODE_VERSION=1.18.30
# Empreintes SHA-512 (dist.integrity du registre npm) des binaires d'opencode ${OPENCODE_VERSION}, vérifiées avant
# extraction : même sans vérification TLS (COCKPIT_TLS_INSECURE=1), un binaire modifié en route est refusé.
# Changer OPENCODE_VERSION impose de mettre à jour ces deux valeurs (npm view <paquet>@<version> dist.integrity).
ARG OPENCODE_INTEGRITY_AMD64=sha512-//sHZuMaNZXo6fzBtgUI5vf1oXiMX9Un2a2R3AUzajRahuW42+98wg9J33uuICblE3RS6G4HxobrvnWA8mr4VA==
ARG OPENCODE_INTEGRITY_ARM64=sha512-KU2VO9oGRhV3M9LCYJXeBBtadIIgJYf620KMHFeghrGL0967Zz7PAcMBFZqTy7gUqNEnMaqOqAkSGx57BIw41Q==
# Proxy d'entreprise éventuel : HTTP_PROXY, HTTPS_PROXY et NO_PROXY sont des arguments prédéfinis de Docker, transmis
# aux étapes RUN sans être déclarés. Surtout pas de « ARG HTTP_PROXY » : sa valeur (identifiants compris) serait
# inscrite dans l'historique de l'image (docker history).
# 1 = construction sans vérification TLS (secours uniquement, voir certs/README.md).
ARG COCKPIT_TLS_INSECURE=0

ENV DEBIAN_FRONTEND=noninteractive

# Autorités de certification d'entreprise facultatives (certs/*.pem|*.crt), montées le temps de cette étape seulement :
# aucune couche ne garde le dossier certs/, et seuls les blocs CERTIFICATE en sont extraits (jamais une clé privée).
# Les dépôts Debian de l'image passent en HTTP : apt fonctionne derrière un proxy TLS.
RUN --mount=type=bind,source=certs,target=/tmp/cockpit-certs \
    set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git less openssh-client procps ripgrep tini; \
    rm -rf /var/lib/apt/lists/*; \
    n=0; \
    for f in /tmp/cockpit-certs/*.pem /tmp/cockpit-certs/*.crt; do \
      [ -f "$f" ] || continue; \
      if grep -q 'BEGIN CERTIFICATE' "$f"; then \
        n=$((n + 1)); \
        sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' "$f" > "/usr/local/share/ca-certificates/cockpit-$n.crt"; \
      fi; \
    done; \
    update-ca-certificates

# opencode épinglé : seul le binaire de la plateforme est téléchargé (npm pack, aucun script d'installation exécuté),
# vérifié contre l'empreinte ci-dessus puis extrait. La variante « baseline » tourne aussi sur les processeurs sans AVX2 (VM).
RUN set -eu; \
    if [ "$COCKPIT_TLS_INSECURE" = "1" ]; then export npm_config_strict_ssl=false; fi; \
    export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) pkg=opencode-linux-x64-baseline; expected="$OPENCODE_INTEGRITY_AMD64" ;; \
      arm64) pkg=opencode-linux-arm64; expected="$OPENCODE_INTEGRITY_ARM64" ;; \
      *) echo "Architecture non prise en charge : $arch" >&2; exit 1 ;; \
    esac; \
    work="$(mktemp -d)"; \
    npm pack --silent --pack-destination "$work" "$pkg@$OPENCODE_VERSION" > /dev/null; \
    tarball="$work/$pkg-$OPENCODE_VERSION.tgz"; \
    actual="sha512-$(node -e 'process.stdout.write(require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "$tarball")"; \
    if [ "$actual" != "$expected" ]; then \
      echo "Empreinte inattendue pour $pkg@$OPENCODE_VERSION : $actual (attendue : $expected)" >&2; \
      exit 1; \
    fi; \
    mkdir -p /opt/opencode; \
    tar -xzf "$tarball" -C /opt/opencode --strip-components=1 --no-same-owner package/bin/opencode; \
    chmod 0755 /opt/opencode/bin/opencode; \
    ln -sf /opt/opencode/bin/opencode /usr/local/bin/opencode; \
    rm -rf "$work"; \
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
    OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_SHARE=1

EXPOSE 4096
HEALTHCHECK --interval=10s --timeout=6s --start-period=30s --retries=12 CMD ["cockpit-healthcheck"]
ENTRYPOINT ["tini", "--", "cockpit-opencode-entrypoint"]
