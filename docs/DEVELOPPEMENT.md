# Développer, tester et publier opencode cockpit

Ce document s'adresse à la personne qui modifie le cockpit, le publie, ou relit sa documentation. Pour installer et utiliser le cockpit, lisez le [README](../README.md) et le [guide d'utilisation](GUIDE.md). L'état du chantier, les décisions et les mesures sont dans le [RECAPITULATIF](RECAPITULATIF.md).

## Arborescence

```text
app/server/            API Node 24 (TypeScript exécuté nativement), SQLite intégré (node:sqlite), Hono.
                       Tests *.test.ts et aides de test test-support/, retirés de l'image par app/Dockerfile.
app/web/               Interface React 19 et Vite.
app/scripts/           dev-open-link.ts (lien de connexion du serveur de développement).
docker/opencode/       Image opencode : Dockerfile, script de démarrage, contrôle de santé,
                       configuration par défaut, extension préinstallée (plugin-seed).
docker/opencode-omo/   Image de la Salle OMO : configuration, vérificateurs, filet de garde (guard/),
                       superviseur, référence du manifeste, contrat-salle.json, audit-baseline.json.
scripts/               run-e2e.sh (banc de bout en bout), build-omo-image.ps1 (image de la salle).
e2e/                   Banc de bout en bout : scénarios, corpus, faux opencode, banc de la salle (omo-banc/).
tests/ps51/            Tests des scripts sous Windows PowerShell 5.1.
docs/                  RECAPITULATIF, NOTES de version, GUIDE, DEVELOPPEMENT, audit de l'extension de la salle.
certs/                 Certificats de l'entreprise (proxy TLS).
.github/workflows/     ci.yml (intégration continue), release.yml (publication).
```

Tableau complet, fichiers créés par l'installation compris : [RECAPITULATIF.md, section 3](RECAPITULATIF.md#3-où-sont-les-fichiers).

## Commandes de développement

```powershell
cd app
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

`npm test` lance `node --test "server/**/*.test.ts"` : tests unitaires et d'intégration.

## Serveur de développement

- `npm run dev:server` lit `app\.env.dev`, jamais versionné. Ce fichier doit contenir `COCKPIT_TOKEN`, `OPENCODE_URL`, `OPENCODE_SERVER_PASSWORD` et les dossiers `COCKPIT_*`. Lancez ensuite `npm run dev:web`.
- Le serveur de développement tourne en mode HTTP local : ajoutez `COCKPIT_LOCAL_SCHEME=http` et `COCKPIT_LOCAL_HTTP_CONFIRMED=<AAAA-MM-JJTHH:MM:SSZ>` aux clés précédentes.
- `npm run dev:link` affiche un lien de connexion à usage unique vers `http://localhost:5173`. Le jeton n'apparaît jamais dans le lien.
- Serveur de développement en HTTPS, facultatif : `COCKPIT_TLS_DIR=<chemin absolu du dossier app\.tls-dev>` et `COCKPIT_OPENSSL=<chemin absolu d'openssl.exe>`. Les deux chemins doivent être absolus : le serveur refuse de démarrer avec un chemin relatif comme `./.tls-dev`.
- `app/.tls-dev/` porte la clé privée du serveur de développement : il est ignoré par git (`.gitignore`) et par le contexte des images (`.dockerignore`). Ne le versionnez jamais.

## Tests

**Unitaires et d'intégration.** `npm test`, dans `app`. Sous Windows, un fichier de test peut s'arrêter en bloc, sans aucun sous-test rouge (code 0xC0000409 relevé) : rejouez ce fichier seul. La cause sera mesurée après la 1.1.0 ([RECAPITULATIF, section 11](RECAPITULATIF.md#11-limites-et-points-à-vérifier)).

**Windows PowerShell 5.1.** Les tests de `tests/ps51/` vérifient `install.ps1`, `cockpit.ps1` et `CockpitTls.ps1` sous Windows PowerShell 5.1, sans Pester :

- `Validate-Scripts.ps1` : règles statiques (scripts en ASCII avec BOM, par l'arbre syntaxique) ;
- `Test-CockpitTls.ps1`, `Test-Install.ps1`, `Test-Cockpit.ps1`, `Test-OmoInstall.ps1`.

Le job « Scripts PowerShell 5.1 (Windows) » de l'intégration continue les joue tous. Mode d'emploi : [`tests/ps51/README.md`](../tests/ps51/README.md).

**Bout en bout.** `scripts/run-e2e.sh`, en bash (Git Bash sous Windows), jamais en intégration continue.

- Isolation : projet Docker, images, volumes et port propres au banc, jamais 7777. Edge ou Chromium est piloté sans dépendance npm. Le banc refuse de démarrer si le projet désigne votre pile, ou si son fichier d'environnement est un `.env`.
- Modes :
  - `--faux` (défaut) : cockpit et faux opencode, aucune IA ;
  - `--reel-hors-ligne` : vrai opencode 1.18.30 et faux fournisseur d'IA, aucun appel facturé ;
  - `--reel` : IA réelle, appels facturés, jamais lancé automatiquement.
- Accès : HTTPS épinglé par défaut, comme une installation réelle ; `--http` garde le mode HTTP explicite.
- Options :
  - `--scenarios <motif>` : seulement les scénarios dont le nom correspond ;
  - `--project-prefix <nom>`, `--image-tag <étiquette>` : nom du projet Docker et des images ;
  - `--salle` : pile de la Salle OMO factice, avec `--faux` seulement ;
  - `--fichier-env <chemin>` : fichier d'environnement de la pile jetable ;
  - `--dry-run` : commandes docker affichées sans être exécutées ;
  - `--garder-pile` : pile laissée debout pour regarder un échec ;
  - `--poste-mouvement <valeur>` : réglage d'animations simulé (`reduce` ou `no-preference`) ;
  - `--autonomie-coupee` : `COCKPIT_AUTONOMY=off` dans le fichier du banc ;
  - `--volume-1-0-6` : avec `--reel-hors-ligne`, volume de configuration d'une installation 1.0.6, migré avant le démarrage ;
  - `--gardes` : refus d'isolation vérifiés, sans Docker ni navigateur.
- Code de sortie : le nombre de scénarios en échec, ou 1 si le banc refuse de démarrer.
- Familles de scénarios, par préfixe : `000-`, `010-`, `it1-`, `it2-`, `it3-`, `it4-`, `c5a-`, `c5b-`, `nav-`, `omo-ui-`, `mw-`. Liste complète et contenu de chaque scénario : [`e2e/README.md`](../e2e/README.md).

**Banc de la salle.** Hors ligne, séparé du banc de bout en bout : [`e2e/omo-banc/README.md`](../e2e/omo-banc/README.md).

## Tests qui lisent la documentation

Une phrase de la documentation citée par un test garde ses mots ; changer ses mots, c'est changer le test dans le même commit.

- **Lecture commune.** Les tests lisent la documentation par l'aide `app/server/test-support/documentation.ts` : fins de ligne CRLF ramenées à LF, espaces insécables (U+00A0, U+202F) ramenées à l'espace ordinaire. Un test vérifie les mots, pas l'espace typographique. La documentation de l'utilisateur est `README.md` et `docs/GUIDE.md`.
- **Phrases verrouillées.** Elles vivent à un seul endroit, désigné par l'identifiant stable du guide :
  - `annonce-110.test.ts` : l'annonce de la 1.1.0, dans [P-08](GUIDE.md#p-08-reprendre-les-réglages-après-une-mise-à-jour-depuis-la-01x) ;
  - `core.test.ts` : les deux réglages HTTPS du serveur de développement, dans ce document ;
  - `croisements-3d-v4.test.ts` : valeurs et phrases de la salle de contrôle, dans [P-39](GUIDE.md#p-39-ouvrir-la-salle-de-contrôle) à [P-41](GUIDE.md#p-41-revenir-à-la-3d-sur-ce-poste), [R-32](GUIDE.md#r-32-salle-de-contrôle-niveaux-et-adresses) à [R-34](GUIDE.md#r-34-lecteur-de-revoir-et-copie-des-consignes) et [X-77](GUIDE.md#x-77-pas-de-bouton-ouvrir-la-salle-de-contrôle) à [X-81](GUIDE.md#x-81-consigne-non-enregistrée-ou-texte-non-affiché-pendant-revoir) ;
  - `croisements-c5b-v4.test.ts` et `demo-equipe.test.ts` : la démonstration d'équipe, [R-45](GUIDE.md#r-45-démonstration-déquipe) ;
  - `croisements-grande-fusion.test.ts` : le contrôle « internet » des étapes, [X-82](GUIDE.md#x-82-un-assistant-est-refusé-comme-étape-déquipe) ;
  - `croisements-it2-v4.test.ts` : la puce « Confirmation avant de relâcher », [R-22](GUIDE.md#r-22-les-quatre-choix-dautonomie) ;
  - `web-rules.test.ts` : ce que refuse **Paramètres › opencode**, [E-03](GUIDE.md#e-03-pourquoi-internet-est-fermé-depuis-la-110) seulement, avec sa limite et son effet sur le réseau.
- **Sections balisées.**
  - Les sections `[3d]` s'ouvrent par un commentaire HTML « [3d] début : … » et se ferment par « [3d] fin », chacune entourée d'une ligne vide. Les trois termes listés par `croisements-3d-v4.test.ts` ne s'écrivent que dans ces sections.
  - La construction a une seule section balisée dans le guide, la balise c5 nommée construction, autour de [R-42](GUIDE.md#r-42-méthodes-livrées-et-leurs-bornes) à [R-45](GUIDE.md#r-45-démonstration-déquipe). `construction-balises.test.ts` trouve toute balise c5, même dans un code en ligne : ce document n'en écrit aucune.
- **Liens et ancres.** `croisements-it1-v5.test.ts` calcule les ancres sur les titres, comme GitHub, et vérifie chaque lien interne. Changer un titre du guide, c'est changer les liens qui le visent. Les identifiants `P-`, `R-`, `X-` et `E-` ne changent jamais.
- **Scénarios cités.** Le même test vérifie que tout scénario cité par son nom existe dans `e2e/scenarios`. La documentation de l'utilisateur et ce document citent les familles par leur préfixe seulement.
- **Pièges pour qui écrit la documentation.**
  - `core.test.ts` lit, dans le README, le guide et ce document, chaque code en ligne qui donne une valeur à `COCKPIT_TLS_DIR` ou à `COCKPIT_OPENSSL`. Une valeur entre chevrons doit dire « chemin absolu » ; une valeur littérale doit être acceptée par le serveur. N'écrivez ces deux réglages qu'avec une valeur `<chemin absolu …>`, comme dans la partie [Serveur de développement](#serveur-de-développement).
  - `fichiers-balises.test.ts` lit tout `docs/` et le README : n'y écrivez aucune balise « nav » en toutes lettres (un chevron ou un commentaire HTML suivi du mot nav et d'un deux-points), même dans un code en ligne pour l'expliquer.
  - Les sections `[3d]` sont repérées par une ligne qui commence, en colonne 0, par le commentaire HTML d'ouverture, même dans un bloc de code : n'en écrivez aucune hors du vrai bloc, et ouvrez le bloc avant le titre qui cite un terme réservé.
- **Grille de rédaction.** `documentation-guide.test.ts` rejoue sur le README, le guide et ce document les règles bloquantes de la grille de rédaction : mots interdits hors code et hors citation (une citation qui en porte un doit être un texte du code), renvois par la position dans la page, au plus 7 étapes par procédure, chacune numérotée, avec son action et son résultat après « → », identifiants existants et liens vers le bon titre, procédures irréversibles [P-17](GUIDE.md#p-17-restaurer-une-sauvegarde-irréversible), [P-19](GUIDE.md#p-19-désinstaller-le-cockpit-irréversible-avec--purge), [P-37](GUIDE.md#p-37-revenir-au-profil-prudent-irréversible-sans-sauvegarde) et [P-56](GUIDE.md#p-56-supprimer-une-conversation-de-larchive-irréversible), README de 450 lignes au plus. Chaque règle a sa faute plantée.
- **Condition.** Ces règles valent avec l'aide de lecture commune et les tests adaptés : les documents et ces tests entrent dans le même commit.

## Intégration continue

`ci.yml` tourne à chaque poussée sur `main` et à chaque demande de fusion. Trois jobs :

- « Application (types, tests, build, audit) » : `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, tests du superviseur de la salle dans un conteneur, `npm run build`, `npm audit --audit-level=high` ;
- « Images Docker » : image opencode, image app, test de fumée HTTPS de l'image app, migration du web dans l'image app ;
- « Scripts PowerShell 5.1 (Windows) » : les cinq scripts de `tests/ps51/`.

Les GitHub Actions sont épinglées par SHA.

## Publier une version

1. Mettez `VERSION`, `app/package.json` et `app/package-lock.json` au même numéro.
2. Poussez le commit **et** l'étiquette `vX.Y.Z` ensemble. Sans l'étiquette, les images de ce numéro n'existent pas, et une installation en `-Mode Pull` les chercherait en vain. `release.yml` refuse une étiquette différente de `VERSION`.
3. La publication, déclenchée par l'étiquette :
   - construit l'image app candidate et joue le test de fumée HTTPS ; si le test échoue, rien n'est poussé ;
   - publie `ghcr.io/<propriétaire>/opencode-cockpit-opencode` et `ghcr.io/<propriétaire>/opencode-cockpit-app`, en `:<version>` et `:latest` ;
   - joint à la release `opencode-cockpit-images-<version>.tar.gz` et son `.sha256`.

Les notes de la release sont générées par GitHub (`generate_release_notes: true`). `docs/NOTES-<version>.md` sert de corps à la demande de fusion vers `main` ; recopiez-le dans la release si ses notes doivent le reprendre.

<!-- [3d] début : three.js dans le build -->

## Dépendance three.js

- `three.js 0.186.0` (licence MIT), seule bibliothèque ajoutée par la 1.1. Version exacte, sans `^` ni `~`, en dépendance de développement : compilée dans l'interface, absente de l'image du serveur.
- SHA-256 de l'archive npm : `61eeff9d7616005c9a481c796f52287d81fbbbc0d55eaca5565322924252c1aa`. Le SHA-512 correspondant est dans `package-lock.json`.
- La garde du build, `app/server/build-three-guard.ts`, fait échouer le build dans quatre cas :
  - un morceau de three contient `new Function` ou `eval(`, sous toutes leurs formes ;
  - un module expérimental de three (`three.webgpu`, `three.tsl`, `examples`, `src`) entre dans le build ;
  - three est atteint par un import statique depuis une entrée : il doit rester chargé à la demande, à l'ouverture de la salle de contrôle ;
  - la licence `licences/three-LICENSE.txt` n'est pas écrite.
- La politique de sécurité du navigateur (CSP) est inchangée, sans `'unsafe-eval'`.

<!-- [3d] fin -->

## Interrupteurs tenus par le code

- **`SALLE_OUVERTE`** (`app/server/wiring-11.ts`) vaut `false`. Plusieurs tests échouent s'il change. La salle ne s'ouvre que par un commit dédié et relu, jamais par une variable d'environnement. Procédure : [RECAPITULATIF, mise en service de la salle](RECAPITULATIF.md#mettre-la-salle-oh-my-openagent-en-service-11-non-publiée).
  - Tant qu'il vaut `false`, toutes les routes de la salle répondent 403.
  - Même salle ouverte, en mode Simple, les routes d'activité et de faits d'une conversation de la salle répondent 403, et ce refus est voulu. « Revoir » y reste servi en lecture seule, une fois la demande terminée, par `GET /api/revoir/:rootId` et `GET /api/revoir/:rootId/consignes/:callId`.
- **`EQUIPES_SIMPLE_OUVERTES`** (`app/server/wiring-eq.ts`) vaut `false` : les équipes restent fermées en mode Simple. L'ouverture tient en une ligne, par une décision humaine, après les essais d'accessibilité (clavier seul, NVDA, captures, test chronométré avec un collègue). La procédure d'ouverture, jouée dans une copie jetable du dépôt, est dans [`e2e/README.md`](../e2e/README.md) ; `ouverture-u1-procedure.test.ts` la vérifie.

## Image de la Salle OMO sur le PC personnel

L'image `opencode-omo` (opencode 1.18.30 et Oh My OpenAgent 4.19.4) n'est jamais publiée : ni registre, ni release, ni intégration continue. Elle se construit à la main, sur le PC personnel, avec Internet ; seule son archive va au travail, où [P-20](GUIDE.md#p-20-charger-limage-de-la-salle-omo-facultatif-la-salle-reste-coupée) du guide la charge.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-omo-image.ps1 `
  -BaseImage <image opencode>@sha256:<64 hex> -OutDir <dossier hors du dépôt>
```

- **Base épinglée.** `-BaseImage` exige l'image opencode du cockpit épinglée par son empreinte. Docker ne résout une empreinte qu'auprès d'un registre, jamais dans le magasin local : une image construite sur place passe d'abord par un registre local jetable. Marche à suivre : [`e2e/omo-banc/README.md`](../e2e/omo-banc/README.md#construire-limage-de-la-salle).
- **Base 1.0.6 ou plus récente exigée.** Le script lit l'environnement de l'image de base et la refuse sans les drapeaux de la 1.0.6 (`OPENCODE_DISABLE_MODELS_FETCH=1`, `npm_config_offline=true`), que la salle hérite. npm n'est remis en ligne que pour les étapes de construction de l'extension. Au poste de travail, `install.ps1 -OmoArchive` ne refuse pas une image sans ces drapeaux : il l'avertit seulement, car ses sorties refusées rempliraient le journal de la salle.
- **Construction.** Sans cache. L'extension s'installe par `npm ci --ignore-scripts` (aucun script d'installation, intégrité SHA-512 du fichier de verrouillage). `npm audit` est comparé à `docker/opencode-omo/audit-baseline.json`, et une alerte haute nouvelle arrête tout. Le SBOM est écrit. La configuration est vérifiée sans réseau (`--network none`), et le manifeste de l'image est comparé à la référence du dépôt.
- **Sortie.** L'archive `opencode-cockpit-omo-4.19.4-<aaaammjj-hhmmss>.tar.gz` et son `.sha256`, de trois lignes (empreinte et nom de l'archive, identifiant d'image, étiquette de l'image), avec le rapport d'audit, le SBOM et les journaux. Dossier par défaut : `%USERPROFILE%\opencode-cockpit-omo`, jamais le dépôt.
- **Options.** `-SelfTest` prouve que la construction refuse une configuration fausse (nom de crochet inconnu, clé inconnue, valeur épinglée retirée). `-DryRun` affiche les commandes sans lancer Docker. `-UpdateLock` régénère le fichier de verrouillage de l'extension. Le script ne pousse jamais rien : aucun `docker push`.
- **Amorçage du manifeste.** `docker/opencode-omo/omo-manifest.sha256` porte l'empreinte de chaque fichier du périmètre de l'image. Le superviseur de la salle refuse de démarrer si l'image s'en écarte, ou si la référence n'est encore qu'une amorce (un fichier réduit à la ligne « # amorce »). `-AcceptManifest` le réécrit : deux constructions sans cache, un manifeste identique exigé, puis la référence écrite dans le dépôt, à relire et à commiter. C'est à refaire après tout changement de l'image de base ou d'un fichier du périmètre ; `app/server/omo-manifeste-sources.test.ts` signale une référence périmée.
- **Transport.** Recopiez l'archive **et** son `.sha256` ensemble jusqu'au poste de travail, sans registre ni partage public.

## Textes de l'interface

Les phrases que la documentation cite entre guillemets sont écrites dans le code :

- `app/server/shared/*-texts.ts`, entre autres `omo-room-texts.ts`, `team-texts.ts`, `agent-map-texts.ts`, `delegation-texts.ts`, `construction-texts.ts`, `salle3d-texts.ts`, `revoir-texts.ts`, `autonomy-choice-texts.ts`, `plan-texts.ts` et `fichiers-texts.ts` ;
- les catalogues `app/server/methods-catalogue.ts` et `app/server/assistants-catalogue.ts`.

La documentation cite ces textes mot pour mot. Une phrase changée dans le code change la documentation dans le même commit.
