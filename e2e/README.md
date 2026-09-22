# Banc e2e du cockpit

Bout en bout, sur une pile Docker **jetable**, isolée de celle de l'utilisateur. Aucune dépendance npm : Node 24
apporte `fetch` et `WebSocket`, Docker monte la pile, et un navigateur déjà installé (Edge ou Chromium) est piloté par
le protocole CDP. Rien ici ne tourne en intégration continue (décision D-06) et rien n'entre dans l'image du cockpit.

```sh
scripts/run-e2e.sh                        # mode --faux : cockpit + faux opencode, en HTTPS épinglé
scripts/run-e2e.sh --http                 # même chose dans le mode HTTP explicite de la 1.0.5
scripts/run-e2e.sh --scenarios 000-smoke  # un seul scénario
scripts/run-e2e.sh --gardes               # vérifie les refus d'isolation et d'épinglage, sans Docker
scripts/run-e2e.sh --reel --dry-run       # montre les commandes docker sans les exécuter
```

Le **code de sortie est le nombre de scénarios en échec** ; 1 quand le banc refuse de démarrer.

## Les trois modes

| Mode | Pile | IA | Facturation |
|---|---|---|---|
| `--faux` (défaut) | cockpit + faux opencode 1.18.30 | aucune | aucune |
| `--reel-hors-ligne` | cockpit + vrai opencode + faux fournisseur compatible OpenAI | aucune IA réelle | aucune |
| `--reel` | cockpit + vrai opencode avec une IA réelle | Copilot | **appels facturés** |

`--reel-hors-ligne` n'existe que parce que la mesure **M-B1** l'a conclu possible : `COCKPIT_ALLOWED_PROVIDERS` réglé
sur le faux fournisseur, `COCKPIT_COPILOT_API_URL` vide, aucun `auth.json`, et une configuration d'opencode dont
`enabled_providers` ne contient que ce fournisseur. Le banc **relit** le compte rendu (`execution/mesures/MX1.md`,
cherché par `E2E_MESURES_DIR` puis dans `execution/mesures`) avant de démarrer ; sans lui, il refuse et le dit.

`--reel` demande l'accord de l'utilisateur et annonce son budget (décision D-12) : il n'est jamais lancé
automatiquement. Le banc, lui, se vérifie à blanc (`--reel --dry-run`).

## Isolation

Tout part de deux fichiers Compose, toujours passés ensemble :

```sh
docker compose -p <préfixe>-<id> -f docker-compose.yml -f e2e/docker-compose.e2e.yml --env-file <fichier temporaire> --profile <mode>
```

- **Projet** : `<préfixe>-<id>`, `cockpit-e2e` par défaut, `it11-e2e` pour le chantier 1.1. Le banc **refuse de
  démarrer** si le nom résolu commence par `opencode-cockpit` ou `ocauto`, avant comme après la normalisation de
  Compose. Le nom est revérifié juste avant chaque commande, `down -v` compris.
- **Images** : `<préfixe>/app:<étiquette>` et `<préfixe>/opencode:<étiquette>`, bâties depuis les sources du dépôt,
  jamais tirées d'un registre (`pull_policy: never`). Une étiquette qui désignerait les images de l'utilisateur est
  refusée.
- **Volumes** : ceux de `docker-compose.yml`, donc préfixés par le projet, donc jetables ; `down -v` les supprime à la
  fin, dans un `finally`.
- **Dossiers** : dossier de travail, archives, captures et fichier d'environnement sous
  `<dossier temporaire>/opencode-cockpit-e2e/<projet>`, hors du dépôt, en 0700.
- **Port** : choisi libre entre 17800 et 17899, différent de 7777, hors `FETCH_BLOCKED_PORTS`
  (`app/server/fetch-ports.ts`) et hors des ports que le navigateur refuse.
- **Fichier d'environnement** : neuf, hors du dépôt, et **jamais** un `.env` — le banc refuse tout chemin dont le nom
  est `.env` ou commence par `.env.`, tout chemin dans le dépôt, et tout fichier qui existe déjà.
- **Verrou** : `<dossier temporaire>/opencode-cockpit-e2e/verrou-reel`. Une exécution réelle le prend ; tant qu'il est
  tenu, **aucune** exécution ne démarre, quel que soit son mode. Le refus donne le processus noté dans `pid.txt` et dit
  s'il tourne encore : si aucune exécution du banc ne tourne, effacez ce dossier.
- **Interruption** : un Ctrl+C (ou un arrêt demandé) fait le même nettoyage que la fin normale — navigateur fermé,
  `down -v`, fichier d'environnement, contexte et verrou effacés — puis quitte ; dès cet arrêt, plus aucune commande
  Compose autre que `down` ne part. Un second Ctrl+C efface tout de suite le fichier d'environnement, le contexte et le
  verrou, sans attendre Docker, et donne la commande pour démonter la pile. Un fichier d'environnement resté malgré
  tout (processus tué) est signalé au démarrage suivant et fait tomber `--gardes`.
- **Réseau** : `internal` (sans Internet) en `--faux` et en `--reel-hors-ligne`. Un conteneur relié au seul réseau
  interne ne reçoit rien de l'hôte, même sur un port publié (mesuré en MX1 §8) : le cockpit est donc aussi relié à un
  pont sans traduction d'adresse, le temps de l'exécution.
- **Secrets** : jeton du cockpit, mot de passe d'opencode et jeton de pilotage sont fabriqués par
  `crypto.randomBytes` à chaque exécution, écrits dans le seul fichier d'environnement (0600), supprimés à la fin
  (interruption comprise), et **jamais affichés** — ni dans les commandes montrées par `--dry-run`, ni dans un
  message d'erreur, ni dans l'adresse de la page (le banc ouvre la session comme `cockpit.ps1 open` de la 1.0.5 :
  défi et demande de ticket signés par le jeton sur `/api/health`, puis `/auth?k=` avec un ticket à usage unique ;
  seules des signatures HMAC partent sur le réseau). Le jeton a le format généré par `install.ps1` (64 hexadécimaux),
  sans lequel la 1.0.5 ne sert ni preuve ni ticket.

- **Environnement de docker** : Compose donne la priorité au shell sur `--env-file`. Le banc retire donc de
  l'environnement passé à docker toute variable `COCKPIT_*` et `E2E_*`, ainsi que `OPENCODE_SERVER_PASSWORD`,
  `WORKSPACE_DIR` et `ARCHIVE_DIR` : un `COCKPIT_LOCAL_SCHEME`, un port ou un jeton resté dans le shell ne peut pas
  changer, sans rien dire, le mode ou le jeton de la pile jetable.

## Accès au cockpit : HTTPS épinglé par défaut, `--http` au besoin

Depuis R105b (décision D-05), le cockpit du banc sert en **HTTPS**, comme une installation 1.0.5, et le banc s'y
connecte comme `cockpit.ps1 open` : il vérifie le certificat, fait prouver au cockpit qu'il connaît le jeton, puis ouvre
la session par un ticket à usage unique. La vérification TLS n'est **jamais** coupée : ni `-k`, ni
`NODE_TLS_REJECT_UNAUTHORIZED=0`, ni `rejectUnauthorized: false`, ni `--ignore-certificate-errors`.

1. **Empreinte lue sur le volume.** Une fois le conteneur démarré, le banc lit les deux fichiers **publics** du volume
   `cockpit-tls` de la pile jetable (`docker compose exec -T cockpit cat /tls/public/cockpit.crt`, puis
   `cockpit-tls.json`), jamais la clé. Il les contre-vérifie avec les règles de `CockpitTls.ps1` et de `tls.ts` : un
   seul certificat, aucun bloc de clé privée, empreinte SHA-256 et condensé de la clé publique (SPKI) du JSON égaux à
   ceux recalculés, clé ECDSA P-256, feuille qui n'est pas une autorité, adresse `127.0.0.1` couverte, dates valables.
   Le serveur réécrit ces fichiers au démarrage : le banc relit jusqu'à obtenir une paire cohérente (120 s au plus).
2. **Node épinglé.** Chaque requête du banc au cockpit passe par `node:https` avec ce certificat pour **seule**
   autorité (`ca`), la vérification exigée (`rejectUnauthorized: true`, nom compris), et un contrôle à chaque poignée de
   main : empreinte SHA-256 et SPKI servis égaux à ceux du volume, sinon la connexion est coupée avant tout envoi.
   `agent: false` : aucune connexion réutilisée, aucun proxy de l'environnement. Une adresse `https://` sans épinglage
   complet est refusée : le banc ne se rabat jamais sur une vérification coupée.
3. **Contre-épreuves à chaque exécution**, sur le cockpit réel de la pile : une autre empreinte attendue doit être
   refusée, et une requête sans aucune option TLS (magasin d'autorités par défaut) aussi. Si l'une passe, le banc
   s'arrête : un processus lancé avec `NODE_TLS_REJECT_UNAUTHORIZED=0` ne peut donc pas faire un banc vert.
4. **Navigateur épinglé.** Edge ou Chromium est lancé avec `--ignore-certificate-errors-spki-list=<SPKI du volume>`
   (Chromium ne l'honore qu'avec un `--user-data-dir`, toujours donné) : seul ce certificat est accepté malgré son
   autorité inconnue, et toute autre erreur de certificat reste bloquante (mesuré dans M25 : sans la liste ou avec une
   autre clé, la page n'est pas servie).
5. **Session.** Défi et demande de ticket signés par le jeton sur `/api/health`, preuve du jeton vérifiée, puis
   `/auth?k=` : cookie `__Host-cockpit_session` (`Secure`, `SameSite=Strict`), posé ensuite dans le navigateur. Le schéma
   annoncé par `/api/health` doit être celui demandé, sinon le banc s'arrête.

Le scénario `000-smoke.mjs` vérifie le résultat de bout en bout : schéma servi, empreinte et SPKI annoncés par le
Diagnostic égaux à ceux épinglés, page en `https:` et contexte sûr, trame `hello` du flux d'événements reçue par la page
sous la CSP réelle.

`--http` garde le **mode HTTP explicite** de la 1.0.5, celui du banc avant R105b : `COCKPIT_LOCAL_SCHEME=http` et date
de confirmation au format strict dans le fichier d'environnement, requêtes par `fetch`, aucun certificat. La connexion
reste par ticket (`POST /api/login` est refusé en HTTP) et le cookie garde son nom `__Host-`, que les navigateurs
acceptent sur `http://127.0.0.1`, origine sûre.

## Écrire un scénario

Un fichier `e2e/scenarios/<nom>.mjs` qui exporte `run(ctx)` :

```js
export async function run(ctx) {
  const reponse = await ctx.api.get("/api/bootstrap");
  await ctx.navigateur.attendreQue("document.querySelector('nav.rail')");
  await ctx.screenshot("accueil");
  ctx.expectNoConsoleErrors();
}
```

Le contexte `ctx` :

| Champ | Ce qu'il donne |
|---|---|
| `navigateur` | l'onglet piloté : `aller`, `evaluer`, `attendreQue`, `texte`, `cliquer`, `taper`, `touche`, `focus`, `taille`, `theme`, `capture`, `journalReseau`, `evenementsFlux` (trames du flux d'événements reçues par la page : nom, adresse, instant ; jamais les données), `horsLigne` (coupure réseau émulée : requêtes nouvelles en échec, « offline » puis « online » ; un flux déjà ouvert n'est pas coupé), `bloquer` (requêtes dont l'adresse correspond à un motif en échec), `retenirReponses` (réponses des requêtes dont l'adresse correspond à un motif retenues avant la page : requête lente dont la réponse date d'avant ce qui suit ; `relacher()` les rend telles quelles), `effacerCookie` (session du navigateur retirée, celle du client d'API reste). `journalReseau` donne aussi l'instant d'envoi de chaque requête (`envoyeeA`, en ms) |
| `url` | adresse du cockpit de la pile jetable (`https://127.0.0.1:<port>`, ou `http://` avec `--http`) |
| `schema` | `https` (défaut) ou `http` (`--http`) |
| `epinglage` | en HTTPS, empreinte SHA-256 du certificat (`sha256`) et condensé de sa clé publique (`spki`) épinglés, lus sur le volume ; `null` en HTTP. Jamais la clé |
| `faux` | pilotage du faux opencode (`requetes`, `evenements`, `scripter`, `tourParDefaut`, `oublier`), ou `null` hors du mode `--faux` |
| `mode` | `faux`, `reel-hors-ligne` ou `reel` |
| `api` | client d'API du cockpit, déjà connecté (`get`, `post`, `put`, `brut`), épinglé en HTTPS. Un scénario ne parle au cockpit que par lui ou par la page : un `fetch` direct vers `ctx.url` échouerait en HTTPS, et c'est voulu |
| `pile` | redémarrage réel d'un service de la pile jetable : `arreter(service)` (`docker compose stop -t 5`) et `demarrer(service)` (`start`), par les commandes Compose du banc (projet revérifié) ; seulement les services du mode courant, jamais `rm`, `kill` ni `down` |
| `screenshot(nom)` | les six captures : 1440, 1024 et 400, en clair et en sombre |
| `expectNoConsoleErrors()` | lève si la console a porté la moindre erreur depuis l'ouverture de l'onglet |
| `opencodeRequests()` | requêtes reçues par opencode (mode `--faux` seulement) |
| `billedCalls()` | appels susceptibles d'être facturés, vus par le banc : requêtes d'envoi en `--faux`, appels au faux fournisseur en `--reel-hors-ligne`. En `--reel`, le banc ne voit pas la facturation de GitHub et le dit plutôt que de mentir |
| `dossierCaptures`, `nom` | où sont écrites les captures, et le nom du scénario |

La session du cockpit est ouverte **avant** le scénario, dans le navigateur comme dans le client d'API : un scénario
ne manipule jamais le jeton.

Un scénario échoue en levant : le banc l'écrit, prend une capture `...-echec.png` et passe au suivant. Le code de
sortie est le nombre d'échecs.

## Fichiers

| Fichier | Rôle |
|---|---|
| `scripts/run-e2e.sh` | point d'entrée, aide, vérifications de base (Node 24, Docker), `MSYS_NO_PATHCONV` |
| `e2e/lib/docker-e2e.mjs` | gardes d'isolation, pile Compose, lecture de l'épinglage sur le volume et contre-épreuves, déroulé, et leurs propres vérifications (`--gardes`) |
| `e2e/lib/cdp.mjs` | navigateur sans fenêtre, profil temporaire neuf, clé publique épinglée, captures, clavier, console, journal réseau, trames du flux |
| `e2e/lib/cockpit.mjs` | contre-vérification du certificat public, transport HTTPS épinglé (ou `fetch` en `--http`), santé, session, client d'API, relevés du faux |
| `e2e/lib/faux-fournisseur.mjs` | faux fournisseur compatible OpenAI (mode `--reel-hors-ligne`) |
| `e2e/lib/opencode-hors-ligne.jsonc` | configuration d'opencode pour ce mode (levier de M-B1) |
| `e2e/fake-opencode-server.ts` | le faux opencode des tests, servi dans la pile jetable |
| `e2e/docker-compose.e2e.yml` | surcharge d'isolation, jamais utilisée seule |
| `e2e/scenarios/` | les scénarios ; `000-smoke.mjs` vérifie le banc lui-même ; `010-reprise-apres-coupure.mjs` vérifie que l'interface se rétablit seule après un rechargement de l'amorçage en échec (coupure réseau, retour de l'onglet, focus sur « Réessayer », onglet caché, redémarrage réel du conteneur, amorçage lent puis deux changements rapprochés, 401) |

<!-- c5:fichiers -->
`e2e/lib/a11y.mjs` (itération 5) est le banc de captures d'accessibilité : réglages système émulés, 3 modes × 2 thèmes ×
3 tailles, animations en cours (toute la page, ou la seule carte de la bande néon), réglages vus par la page, focus visible.
Il est décrit ici, sous le tableau et non dedans : un commentaire HTML posé entre deux lignes d'un tableau ouvre un bloc
HTML et coupe le tableau au rendu (GitHub, VS Code). Détails à la section « Banc de captures d'accessibilité », plus bas.
<!-- /c5:fichiers -->

`e2e/fake-opencode-server.ts` n'ajoute rien au faux : il l'enveloppe. Le faux écoute sur la boucle locale (le bon
choix dans les tests) ; un relais d'octets l'expose sur 4096 pour le cockpit, sans toucher aux en-têtes ni au flux
d'événements. Les sources sont montées en lecture seule, parce que l'image finale du cockpit ne contient ni les tests
ni le faux.

## Réglages

| Variable | Effet |
|---|---|
| `E2E_NAVIGATEUR` | chemin du navigateur (sinon Edge puis Chromium, aux emplacements usuels) |
| `E2E_MESURES_DIR` | dossier où lire `MX1.md` pour `--reel-hors-ligne` |
| `E2E_ACCORD_FACTURE` | accord écrit pour une recette facturée : `it1-ui-m1-noreply.mjs` ne joue la mesure M1 qu'en `--reel` et si la valeur contient `M1` |
| `E2E_M1_IA` | IA de la recette M1, séparées par des virgules (sinon la première IA Claude et la première IA GPT du catalogue) |

Ces chemins sont lus par Node : sous Git Bash, écrivez-les à la mode Windows (`C:/…`) et non `/c/…`.

## Scénarios de l'itération 1 (chantier 1.1)

```sh
scripts/run-e2e.sh --faux --scenarios 'it1-*' --project-prefix it11-e2e --image-tag it11
scripts/run-e2e.sh --reel-hors-ligne --scenarios 'it1-*' --project-prefix it11-e2e --image-tag it11
```

Un fichier `*-commun.mjs` porte les outils de sa famille et vérifie leurs préalables : le banc le joue comme un
scénario. Chaque autre scénario qui agit sur opencode (conversation créée, message envoyé, plan créé) le fait sous le
témoin P6 (aucun `PATCH /global/config`, `/global/dispose` ni `/instance/dispose`, flux d'opencode jamais coupé) et P4
(seulement `once` et `reject` envoyés), par `avecTemoinP6` ; un test de `npm test` (`croisements-it1-v5`) le vérifie.
En `--reel-hors-ligne`, le faux fournisseur ne répond que du texte : ce qui demande qu'une IA appelle un outil
(délégation, lecture d'un fichier) y est annoncé « non joué ».

**Écart D-05 levé.** Ces scénarios tournaient sur un cockpit servi en HTTP. Depuis R105b, ils passent par le transport
du banc dans les deux modes : le flux d'événements du témoin P6 (`it1-api-commun.mjs`) est ouvert par `ctx.api.flux`,
la CSP de la page (`it1-ui-commun.mjs`, `it1-ui-m25.mjs`) est lue par `ctx.api.brut`, et l'adresse comme le protocole
de la page sont comparés au schéma du banc (`ctx.schema`), non plus à `http:`. Plus aucun `fetch` nu vers le cockpit :
un banc en HTTPS épinglé le refuserait. Un test de `npm test` (`croisements-it1-v5`) le vérifie.

Par l'API du cockpit :

| Scénario | Ce qu'il établit |
|---|---|
| `it1-api-commun.mjs` | préalables : mode Simple par défaut, opencode joint, IA du banc au catalogue, agents internes installés, témoin P6, outils du faux conformes à la mesure M2 |
| `it1-api-arret.mjs` | « Arrêter » : demande en attente refusée, racine arrêtée la première, plus aucune session de l'arbre occupée ; « Autoriser une fois » tardif refusé |
| `it1-api-m16.mjs` | mesure M16 : le plancher posé à la création ne change ni le titre ni l'archive |
| `it1-api-pfx-explore.mjs` | un enfant `explore` hérite du plancher : `cle.pfx` refusé sans demande, `notes.txt` lu |
| `it1-api-plan.mjs` | Plan d'abord : plancher PLAN, outils retirés pour la racine et pour l'enfant (mesure M2) |
| `it1-api-plancher.mjs` | plancher de conversation posé et relu, aucun outil retiré, fichier de clés refusé sans demande |

Par la page, en agissant comme un utilisateur (clic, clavier), avec captures 1440, 1024 et 400 dans les deux thèmes et
console muette :

| Scénario | Ce qu'il établit |
|---|---|
| `it1-ui-commun.mjs` | préalables : mode Simple par défaut, page servie dans le schéma du banc sous la CSP réelle, règles acceptées au clic, flux d'événements ouvert ; relevés installés dans la page (faisceaux, animations, violations de CSP) |
| `it1-ui-delegation.mjs` | mode Avancé, demande posée quelques millisecondes après la partie `task` comme sur opencode réel (`askAfterMs` du faux) : carte « Détails de la délégation » ; sans aucun clic pendant la demande, carte des agents et « Qui travaille ? » dépliés, attente de votre accord (hexagone hachuré, cadenas, ambre) et préparation (pointillé rose fixe) visibles dans la fenêtre, titre, lignes et [Répondre] de « Qui travaille ? » vus (elementFromPoint, pas seulement rendus) ; « Autoriser une fois » cliqué, faisceau rose (préparation, consigne) puis bleu (résultat), dans l'ordre des faits |
| `it1-ui-arreter.mjs` | « Arrêter » visible pendant le travail délégué ; le clic arrête tout l'arbre et la consigne est figée en gris |
| `it1-ui-mise-en-page.mjs` | mode Avancé, délégation en attente puis en cours, à 1440, 1280, 1024 et 400 px : fil et « Qui travaille ? » visibles, « Autoriser une fois », « Refuser… » et « Arrêter » dans la fenêtre et non recouverts (elementFromPoint), [Répondre] atteignable (au besoin en faisant défiler la seule région d'activité), zone principale jamais défilée, « Contexte » fermé de lui-même sous 1280 px ; carte des agents dépliée pendant la demande ; tout relevé vu (elementFromPoint) : titre de « Qui travaille ? » vu sans défiler aux quatre tailles, ses lignes et [Répondre], l'attente de votre accord et la préparation vues sans défiler à 1440 et 1280, atteintes en faisant défiler la région et la bande à 1024 × 768 (la saisie y prend 428 px), bandeau d'une ligne et [Répondre] vus à 400 ; [Répondre] focalise « Autoriser une fois » ; modification en attente sur la racine, à 1440 : « Qui travaille ? » et l'attente de votre accord vus sans défiler |
| `it1-ui-demonstration.mjs` | démonstration en Simple puis en Avancé : étiquette, avis du mode Simple, tous les moments parcourus, zéro requête de la page et d'opencode |
| `it1-ui-p2-raccourci.mjs` | capture p2 : délégation d'un raccourci `subtask` lancée sans demande, enregistrée « sans confirmation », et « lancé sans confirmation » affiché |
| `it1-ui-m25.mjs` | mesure M25 dans le schéma du banc (HTTPS épinglé par défaut) : CSP servie, flux d'événements, transitions WAAPI de 900 ms jouées une fois, aucune violation |
| `it1-ui-selecteur-clavier.mjs` | sélecteur « Autonomie » au clavier seul (APG), jusqu'à la création de « Plan d'abord (nouvelle conversation) » par Entrée ; le focus reste sur le bouton du sélecteur dans la conversation de plan |
| `it1-ui-m1-noreply.mjs` | mesure M1 : recette facturée, jouée seulement en `--reel` avec `E2E_ACCORD_FACTURE` (en attente) ; ailleurs, une répétition sans IA réelle (deux envois `noReply` sans tour, puis une réponse) |

<!-- c5:scenarios -->
## Scénarios de l'itération 5 (construction : méthodes, Seconde lecture, chronologie)

```sh
scripts/run-e2e.sh --faux --scenarios c5a- --project-prefix c511-e2e --image-tag c511
scripts/run-e2e.sh --reel-hors-ligne --dry-run --scenarios c5a- --project-prefix c511-e2e --image-tag c511
# Répétition générale, MC5-1 sur le code réel (projets c511-rg-*, E2E_MESURES_DIR = dossier des mesures) :
scripts/run-e2e.sh --reel-hors-ligne --scenarios c5a-mc5-reel --project-prefix c511-rg --image-tag c511
```

**Le préfixe `c511-e2e` est obligatoire** : le préfixe par défaut `cockpit-e2e` est celui du banc de l'itération 1-2,
qui tourne en même temps sur une autre branche. Le nettoyage ne vise que `c511-e2e-*` et les images `c511-e2e/*`.

| Scénario | Ce qu'il établit |
|---|---|
| `c5a-methodes.mjs` | un assistant avec deux méthodes : « Utilisée par » au catalogue, troisième méthode refusée dans la bibliothèque (« 2 méthodes au maximum … »), ligne « Méthodes : … » sur sa fiche d'identité ; la puce « + Méthode » AU CLAVIER SEUL (APG : flèche bas ouvre, Entrée coche et décoche, Échap ferme et rend le focus au bouton), méthodes déjà dans l'assistant désactivées ; à l'envoi, le faux opencode reçoit le BLOC à la fin du texte écrit ; bulle repliée « Méthode demandée : … » sans le marqueur ; « Méthode appliquée » puis « Méthode non détectée dans la réponse » ; raccourci « /… » : puce désactivée avec sa raison |
| `c5a-seconde-lecture.mjs` | Relecteur absent : la phrase et [Installer], aucun montant ; installation au clic par le catalogue ; bouton « Seconde lecture (≈ … $) » sans « au moins », infobulle qui nomme l'IA du Relecteur puis la base de l'estimation ; au clic, UN seul envoi, avec l'agent du Relecteur et la phrase exacte du §4.3 ; pied « Relecture par un autre assistant … » ; à la réouverture, le composeur a gardé l'assistant précédent |
| `c5a-chronologie.mjs` | en Avancé : bascule « Déroulé \| Chronologie » (radiogroup, un seul bouton dans l'ordre de tabulation), lignes, colonne « Jetons (entrée / sortie / cache) », repères d'outil, curseur « maintenant » PENDANT le travail ; à 400 px la figure disparaît et le tableau reste seul ; en Simple : aucune bascule, aucune chronologie, et le mot « jeton » nulle part |
| `c5a-a11y.mjs` | banc de captures d'accessibilité : six vues (bibliothèque, écran « Consignes et fiches », popover de la puce, bulle, chronologie, Coûts par équipe vides) × 3 modes × 2 thèmes × 3 tailles = 108 fichiers ; mouvement réduit vérifié par un relevé DISCRIMINANT sur la transition de la carte de la bande néon (la seule animation que le réglage commande) : la même action, un second tour envoyé pendant que la carte est affichée, anime la carte en mode normal (au moins une animation en cours, relevée sans délai) et ne l'anime plus en mouvement réduit (zéro, le réglage vu par `matchMedia` dans la page), puis plus rien ne tourne au repos ; en contraste forcé, focus visible, c'est-à-dire un contour réellement dessiné (`:focus-visible` seul ne suffit pas) |
| `c5a-mc5-reel.mjs` | **répétition générale, `--reel-hors-ligne` seulement** (non joué en `--faux`) : MC5-1 rejouée sur le CODE RÉEL avec un vrai opencode 1.18.30 et le faux fournisseur hors ligne. Dans une seule conversation : envoi à « Analyser un incident » (204 sans corps), puis au « Relecteur critique » — invite système différente et tout l'historique transmis —, puis de nouveau au premier assistant, qui retrouve SON invite système (le Relecteur ne colle pas à la session) ; `agent` sur chaque message de `GET /session/:id/message`, messages `user` compris ; `GET /api/chat/choices/:id` rend l'assistant précédent (ligne `chat_turns` requalifiée, D-5-06). Les parties d'outil de MC5-1 ne sont pas rejouées ici : le faux fournisseur ne répond que du texte — ce point reste tenu par la mesure MC5 elle-même. |

### Banc de captures d'accessibilité (`e2e/lib/a11y.mjs`)

Trois modes, parce que ce sont les trois qui changent le dessin : `normal`, `contraste-force`
(`forced-colors: active`, mode contrasté de Windows) et `gris-mouvement-reduit`
(`prefers-reduced-motion: reduce` avec une vue sans couleurs). Chacun dans les deux thèmes et aux trois tailles :
`<scénario>-<vue>-<mode>-<taille>-<thème>.png`.

Les trois réglages de média (`prefers-color-scheme`, `forced-colors`, `prefers-reduced-motion`) passent depuis FE4 par
`onglet.medias({theme, forcedColors, reducedMotion})` de `cdp.mjs`, la seule aide d'émulation de média du banc
(itération 4, L41), qui les envoie EN UN SEUL APPEL (`Emulation.setEmulatedMedia` remplace toute la liste). Les
couleurs restent dans `a11y.mjs`, par l'envoi brut de `cdp.mjs`
(`navigateur.client.envoyer("Emulation.setEmulatedVisionDeficiency", …, onglet.sessionId)`).
`e2e/lib/cdp.mjs` n'est jamais écrit par l'itération 5.
Le contexte d'un scénario ne porte que l'ONGLET : `ouvrirNavigateurEpingle(ctx)` ouvre un navigateur propre au
scénario, avec le même épinglage et la même isolation, fermé dans un `finally`.

### Ce que le banc dit au faux opencode

Les réponses sont scriptées par les scénarios (`ctx.faux.scripter`, `ctx.faux.tourParDefaut`) : en-tête de méthode
(« ### Méthode : … ») pour la détection, et lignes `usage` à jetons pour la chronologie et pour la base
« conversation » de l'estimation de la Seconde lecture.

Les AGENTS servis par `GET /agent` se déclarent par la conversation réservée `banc:agents`
(`ctx.faux.scripter("banc:agents", { agents: [{ name, description, model }] })`, section `c5:agents-du-banc` de
`e2e/fake-opencode-server.ts`) : le faux ne lit aucun fichier, alors que le cockpit ne propose une seconde lecture,
et ne propose un assistant au composeur, que si opencode le lui rend. La déclaration se fait **après** l'installation :
avant, le nom serait déjà pris et le cockpit en choisirait un autre (« relecteur-critique-2 »).

<!-- /c5:scenarios -->

<!-- équipes (it4) : début -->
## Scénarios de l'itération 4 — équipes et carte des assistants (chantier 1.1)

```sh
scripts/run-e2e.sh --faux --scenarios 'it4-*' --project-prefix eq11-e2e --image-tag eq11
scripts/run-e2e.sh --reel-hors-ligne --scenarios it4-outils-etape --project-prefix eq11-e2e --image-tag eq11
```

Aucun appel facturé, aucun jeton Copilot : faux opencode, ou opencode 1.18.30 réel avec le faux fournisseur hors ligne.
`it4-commun.mjs` porte les outils de la famille et vérifie ses préalables, comme les `*-commun.mjs` de l'itération 1.
Trois formes réservées de `sessionID` pilotent le faux depuis un scénario (`e2e/fake-opencode-server.ts`) :
`quand:<champ>=<valeur>` (scripter les sessions d'étape que le runner crée lui-même), `config:global` (configuration
globale lue à l'estimation) et `agents:defaut` (agents servis par `GET /agent`, que le faux ne lit pas dans les fichiers
du Studio).

| Scénario | Ce qu'il établit |
|---|---|
| `it4-commun.mjs` | préalables : mode Simple par défaut, équipes fermées en Simple dans le dépôt, exemples au catalogue, carte ouverte, pilotage du faux accepté (et un sélecteur inconnu refusé) |
| `it4-avis.mjs` | « Revue SQL sur réplica » de bout en bout : trois avis démarrés à moins de 2 s d'écart, chacun sans voir les autres, synthèse qui les reçoit tous, résultat injecté `noReply` et carte « … recopié ici par le cockpit, sans appel d'IA. », une seule fois, sans marqueur |
| `it4-pause.mjs` | « Chaîne de relecture de script » : pause du déroulé après l'étape 1, rien envoyé pendant la pause, [Continuer] avec une précision → précision présente dans le message de l'étape 2 (journal du faux) |
| `it4-arret.mjs` | arrêt pendant l'étape 2 : équipe `arretee`, aucune session occupée, aucun envoi après l'arrêt ; arrêt au plafond : état `plafond`, plus aucun envoi, et le lancement reste relançable |
| `it4-studio.mjs` | garde de rechargement composée pendant une étape : Studio, réalignement (confirmé depuis la page) et redémarrage d'opencode refusés en 409, installation d'un exemple aussi ; acceptés après l'équipe, une fois le repos attendu et mesuré sur les sessions d'étape **de ce lancement**, et sur elles seules — jamais sur tout le dossier `/workspace`, que les 27 scénarios partagent (le refus qui suit « terminee » est voulu : opencode compte encore la session occupée) ; témoin P6 |
| `it4-carte.mjs` | `GET /api/agent-map` : `build` → `general` et `explore` « demandée », appliquées par opencode ; carte en lecture seule ; vues Centrée et Liste au clavier seul ; une arête par étape, numérotées |
| `it4-prelancement.mjs` | « Rien n'a été envoyé ni facturé » : chaque refus de `POST …/run` et de `POST …/relancer` laisse le faux sans la moindre requête, pour un code de chaque groupe ; `mcp` ajouté après l'estimation → 202 puis pause « À vérifier », sans envoi. Le scénario pose **lui-même ses deux équipes**, dérivées du même exemple (il ne suppose aucun exemple installé par un autre scénario), attend que l'instantané des agents du cockpit ait expiré avant de compter les lectures de l'estimation, met le classement automatique des conversations de côté le temps de la mesure, et ne mesure un refus qu'après une fenêtre calme plus large que le rafraîchissement d'archive (4 s). Une mesure salie par cette relecture d'archive (`GET /session/:id` et `GET /session/:id/message`, et elles seules) est REPRISE, au plus deux fois ; toute autre requête fait tomber le refus sur-le-champ |
| `it4-outils-etape.mjs` | outils offerts à l'IA d'une étape : ni `edit`, `write`, `apply_patch`, `bash`, `task`, `webfetch`, `websearch` ni `question` (journal du faux fournisseur en `--reel-hors-ligne`, oracle du faux en `--faux`) |
| `it4-captures.mjs` | captures 1440, 1024 et 400 px dans les deux thèmes de chaque vue neuve ; contraste forcé émulé (`forced-colors: active`) et mouvement réduit pour la feuille, le Déroulé, l'éditeur, la carte et la carte d'exécution en pause ; feuille et éditeur au clavier seul ; console muette |
| `it4-simple-ouvert.mjs` | ouverture des équipes en mode Simple (décision U1). Son corps ne s'exécute que si `EQUIPES_SIMPLE_OUVERTES` est vraie ; sinon il s'annonce « non joué » et **ne vérifie rien**, tout en comptant vert. Pour le jouer : passer `app/server/wiring-eq.ts` à `export const EQUIPES_SIMPLE_OUVERTES = true;` dans la copie jetable du banc, **avant de bâtir les images** (le banc prépare son contexte à partir du dossier de travail), jamais dans le dépôt (U1), puis `scripts/run-e2e.sh --faux --scenarios it4-simple-ouvert …`, et remettre la ligne à `false`. Joué ainsi le 21 septembre 2026 : **vert** (22 s) |


<!-- équipes (it4) : fin -->

## Contrôle des types

`e2e/fake-opencode-server.ts` est le seul fichier TypeScript du banc, et il vit hors de `app/` : `npm run typecheck`
ne le voit pas. Depuis la racine du dépôt, avec le TypeScript déjà installé dans `app/` (aucune dépendance en plus) :

```sh
node app/node_modules/typescript/bin/tsc --noEmit --module nodenext --moduleResolution nodenext \
  --target ES2024 --lib ES2024,DOM,DOM.Iterable --strict --noUncheckedIndexedAccess \
  --allowImportingTsExtensions --erasableSyntaxOnly --verbatimModuleSyntax --skipLibCheck \
  --types node --typeRoots app/node_modules/@types e2e/fake-opencode-server.ts
```

## Dépannage

- **« aucun navigateur trouvé »** : installez Edge ou Chromium, ou donnez son chemin dans `E2E_NAVIGATEUR`.
- **« le cockpit ne répond pas »** : relancez avec `--garder-pile`, puis
  `docker compose -p <projet> logs cockpit`. Pensez à `docker compose -p <projet> down -v` ensuite.
- **« certificat public du cockpit illisible sur le volume »** : le cockpit n'a pas écrit `cockpit.crt` et
  `cockpit-tls.json`, ou ils se contredisent ; le message donne la dernière raison. Voir les journaux du cockpit comme
  ci-dessus. `--http` permet de continuer sans HTTPS, en le disant.
- **« certificat servi différent de celui du volume »** : le cockpit joint n'est pas celui de la pile jetable, ou son
  certificat a changé depuis la lecture. Le banc s'arrête sans réessayer : ce n'est pas un démarrage lent.
- **« contre-épreuve : … accepté sans épinglage »** : la vérification TLS est coupée dans le processus (par exemple
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, ou une autorité ajoutée par `NODE_EXTRA_CA_CERTS`) ; retirez-la, le banc refuse de
  prouver quoi que ce soit dans ces conditions.
- **Un scénario échoue sans raison claire** : la capture `<scénario>-echec.png` est dans le dossier des captures,
  affiché à la fin de l'exécution.
