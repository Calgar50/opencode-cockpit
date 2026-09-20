# syntax=docker/dockerfile:1
# Sonde du contexte de construction : recopie tout ce que le demon Docker recoit vers la sortie locale de buildx, pour
# verifier qu'aucune cle privee, aucun .env et aucune donnee locale n'y entre (.dockerignore).
#
#   docker buildx build -f .github/ci/context-probe.Dockerfile --output type=local,dest=ctx .
#
# Cette image n'est ni publiee ni utilisee par le cockpit : elle n'a pas de couche de base et n'execute rien.
FROM scratch
COPY . /contexte
