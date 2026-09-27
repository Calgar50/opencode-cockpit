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
scripts/run-e2e.sh --poste-mouvement reduce  # poste simulé en animations réduites (voir « Réglage de mouvement »)
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
  pont sans traduction d'adresse, le temps de l'exécution. Depuis la 1.0.6, le vrai opencode reste, comme dans une
  installation, sur le seul réseau `interne` de `docker-compose.yml`, derrière le relais du cockpit (liste fermée
  Copilot) ; en `--reel-hors-ligne`, le faux fournisseur rejoint ce réseau et figure dans le `NO_PROXY` d'opencode,
  dans la surcharge du banc seulement : opencode le joint en direct, jamais par le relais. En `--faux`, le service
  `opencode` n'existe pas : le relais du cockpit attend son pair (un avertissement au démarrage) et n'écoute jamais.
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

## Réglage de mouvement : jamais celui du poste

Le navigateur du banc rapporte `prefers-reduced-motion` d'après le réglage d'animations du poste, et Windows passe en
animations réduites avec les sessions RDP. Sous `reduce`, le cockpit fait ce que la spécification demande : aucune
transition WAAPI sur la carte des agents, transitions CSS ramenées à 0,01 ms. Des scénarios qui vérifient ces
transitions tombaient donc selon l'état du poste (`it1-ui-arreter`, `it1-ui-delegation`, `it1-ui-m25` ; cause établie
par la répétition générale de la 5b, contre-épreuve à trois endroits). Depuis R106-b :

- **chaque scénario qui agit sur la page fixe son réglage** avant sa première action : `preparerPage` (outils
  `it1-ui-commun.mjs`, repris par `it2-ui-commun.mjs`) pose `no-preference`, et un scénario qui teste justement le
  mouvement réduit le demande, par `preparerPage(ctx, taille, { mouvement: "reduce" })` ou `ctx.navigateur.mouvement("reduce")` ;
  `000-smoke.mjs` et `010-reprise-apres-coupure.mjs` le posent eux-mêmes ;
- `theme()` et la fin de `screenshot` / `captureSuite` envoient le réglage de mouvement **avec** le thème : le protocole
  remplace toute la liste des médias émulés à chaque envoi, et ces deux envois rendaient la page au réglage du poste ;
- **garde du banc** : pendant chaque scénario, le banc relève tout ce qui est envoyé à la page. Une action faite avant
  que le réglage soit fixé, une émulation de média qui le perd, ou une page qui rapporte, à la fin, autre chose que le
  réglage fixé font **échouer le scénario**, avec la raison. Un scénario qui n'agit pas sur la page (scénarios d'API)
  n'est pas concerné. La ligne « ok » donne le réglage lu dans la page (`mouvement no-preference`) ;
- chaque exécution écrit, avant les scénarios, ce que le navigateur rapporte **sans** émulation ;
- `--poste-mouvement reduce` (ou `no-preference`) **simule** le réglage du poste pour le navigateur du banc
  (`--force-prefers-reduced-motion` ou `--force-prefers-no-reduced-motion` de Chromium, recouverts par l'émulation
  comme le vrai réglage de Windows), sans toucher au poste : c'est la contre-épreuve de l'indépendance.

## Écrire un scénario

Un fichier `e2e/scenarios/<nom>.mjs` qui exporte `run(ctx)` :

```js
export async function run(ctx) {
  const reponse = await ctx.api.get("/api/bootstrap");
  await ctx.navigateur.mouvement("no-preference"); // avant toute action sur la page (garde de R106-b)
  await ctx.navigateur.attendreQue("document.querySelector('nav.rail')");
  await ctx.screenshot("accueil");
  ctx.expectNoConsoleErrors();
}
```

Le contexte `ctx` :

| Champ | Ce qu'il donne |
|---|---|
| `navigateur` | l'onglet piloté : `aller`, `evaluer`, `attendreQue`, `texte`, `cliquer`, `taper`, `touche`, `focus`, `taille`, `theme` (le réglage de mouvement part avec lui), `mouvement` (`prefers-reduced-motion` fixé : `no-preference` ou `reduce`, à poser avant toute action sur la page, voir « Réglage de mouvement »), `capture`, `journalReseau`, `evenementsFlux` (trames du flux d'événements reçues par la page : nom, adresse, instant ; jamais les données), `horsLigne` (coupure réseau émulée : requêtes nouvelles en échec, « offline » puis « online » ; un flux déjà ouvert n'est pas coupé), `bloquer` (requêtes dont l'adresse correspond à un motif en échec), `retenirReponses` (réponses des requêtes dont l'adresse correspond à un motif retenues avant la page : requête lente dont la réponse date d'avant ce qui suit ; `relacher()` les rend telles quelles), `effacerCookie` (session du navigateur retirée, celle du client d'API reste). `journalReseau` donne aussi l'instant d'envoi de chaque requête (`envoyeeA`, en ms) |
| `url` | adresse du cockpit de la pile jetable (`https://127.0.0.1:<port>`, ou `http://` avec `--http`) |
| `schema` | `https` (défaut) ou `http` (`--http`) |
| `epinglage` | en HTTPS, empreinte SHA-256 du certificat (`sha256`) et condensé de sa clé publique (`spki`) épinglés, lus sur le volume ; `null` en HTTP. Jamais la clé |
| `faux` | pilotage du faux opencode (`requetes`, `evenements`, `scripter`, `tourParDefaut`, `oublier`), ou `null` hors du mode `--faux` |
| `mode` | `faux`, `reel-hors-ligne` ou `reel` |
| `api` | client d'API du cockpit, déjà connecté (`get`, `post`, `put`, `brut`, `flux`), épinglé en HTTPS. `brut(methode, chemin, corps, { entetes })` rend `{ code, entetes, corps }` et accepte des en-têtes de plus, pour ceux que les raccourcis ne posent pas (`x-cockpit-confirm: 1`) ; `flux(chemin, { signal })` ouvre un flux d'événements lu au fil de l'eau. Un scénario ne parle au cockpit que par lui ou par la page : un `fetch` direct vers `ctx.url` échouerait en HTTPS, et c'est voulu |
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
| `e2e/lib/docker-e2e.d.mts` | déclaration de types minimale de `docker-e2e.mjs` (`correspond`, `listerScenarios`) pour les tests de croisement de `app/server`, qui appliquent la règle de `--scenarios` telle quelle au lieu de la recopier |
| `e2e/lib/cdp.mjs` | navigateur sans fenêtre, profil temporaire neuf, clé publique épinglée, captures, clavier, console, journal réseau, trames du flux ; médias émulés (thème et mouvement toujours ensemble) et relevé du réglage de mouvement pour la garde de R106-b |
| `e2e/lib/cockpit.mjs` | contre-vérification du certificat public, transport HTTPS épinglé (ou `fetch` en `--http`), santé, session, client d'API, relevés du faux |
| `e2e/lib/faux-fournisseur.mjs` | faux fournisseur compatible OpenAI (mode `--reel-hors-ligne`) |
| `e2e/lib/opencode-hors-ligne.jsonc` | configuration d'opencode pour ce mode (levier de M-B1) |
| `e2e/fake-opencode-server.ts` | le faux opencode des tests, servi dans la pile jetable ; avec `--salle`, aussi la salle factice, le faux catalogue Copilot et la préparation de leur pile |
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
| `E2E_OMO_ETAPES` | étapes de `omo-ui-salle.mjs` à rejouer seules, séparées par des virgules (voir la [Salle OMO](#scénario-de-linterface-de-la-salle-omo-chantier-11-l26c)) |

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
| `it1-api-commun.mjs` | préalables : mode Simple par défaut, opencode joint, IA du banc au catalogue, agents internes installés, témoin P6, outils du faux conformes à la mesure M2, prise pour la configuration que sert la pile (depuis R106-a, le profil livré que sert le faux refuse webfetch et websearch, que la configuration de M2 laissait sur « ask » : ils sortent des listes attendues en `--faux`, et seulement là) |
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
| `it1-ui-demonstration.mjs` | démonstration en Simple puis en Avancé : étiquette, avis du mode Simple, tous les moments parcourus, zéro requête de la page (la relecture de sa propre liste par la page du chat, `GET /api/archive`, et une reconnexion de son flux comptées à part) et rien reçu par opencode sur la conversation, aucun appel d'IA hors son classement automatique |
| `it1-ui-p2-raccourci.mjs` | capture p2 : délégation d'un raccourci `subtask` lancée sans demande, enregistrée « sans confirmation », et « lancé sans confirmation » affiché |
| `it1-ui-m25.mjs` | mesure M25 dans le schéma du banc (HTTPS épinglé par défaut) : CSP servie, flux d'événements, transitions WAAPI de 900 ms jouées une fois, aucune violation |
| `it1-ui-selecteur-clavier.mjs` | sélecteur « Autonomie » au clavier seul (APG), jusqu'à la création de « Plan d'abord (nouvelle conversation) » par Entrée ; le focus reste sur le bouton du sélecteur dans la conversation de plan |
| `it1-ui-m1-noreply.mjs` | mesure M1 : recette facturée, jouée seulement en `--reel` avec `E2E_ACCORD_FACTURE` (en attente) ; ailleurs, une répétition sans IA réelle (deux envois `noReply` sans tour, puis une réponse) |
## Scénarios de l'itération 2 (chantier 1.1)

L'itération 2 est « l'autonomie contrôlée ». Ses scénarios se lancent comme ceux de l'itération 1 :

```sh
scripts/run-e2e.sh --faux --scenarios 'it2-*' --project-prefix i211-e2e --image-tag i211
scripts/run-e2e.sh --reel-hors-ligne --scenarios 'it2-*' --project-prefix i211-e2e --image-tag i211
```

Mêmes règles que pour l'itération 1 : un fichier `*-commun.mjs` porte les outils de sa famille et vérifie ses
préalables, et chaque autre scénario qui agit sur opencode le fait sous le témoin P6 et P4 (`avecTemoinP6` d'
`it1-api-commun.mjs`) — **sauf trois** : `it2-api-interrupteur.mjs`, `it2-ui-onglet-ferme.mjs` et
`it2-ui-selecteur-clavier.mjs`, qui n'ont que le journal des requêtes du faux opencode (`exigerP6SurRequetes` d'
`it2-api-commun.mjs`). Ce journal n'existe qu'en `--faux` : **ces trois-là ne vérifient donc rien de P6 ni de P4 en
`--reel-hors-ligne`**, là où le témoin complet contrôle en plus les libérations d'instance relayées et la coupure du
flux d'opencode. La liste de ces trois exemptés est figée par un test de `npm test` (`croisements-it2-v4`) : un
nouveau scénario `it2-*` qui agit sur opencode hors du témoin doit être ajouté ici et dans ce test.

**Atelier.** L'autonomie décide sur des faits du disque : les règles de modification résolvent les chemins et la porte
des commandes lit le sous-arbre et `.git/config`. `it2-api-commun.mjs` prépare donc, une seule fois, deux petits dépôts
dans le dossier de travail monté par le banc : `it2-atelier` (dépôt propre) et `it2-piege` (dépôt dont le `.git/config`
porte `core.pager`, ce qui fait attendre toute commande `git` — règle G04).

**Corpus de la barrière des 60.** `e2e/corpus/controle-60.json` porte les soixante commandes de la recette M8 (trente
inoffensives, trente nuisibles). Le banc en vérifie seulement la **forme** à chaque passage ; **aucune de ces commandes
n'est soumise**, ici ni ailleurs : la barrière est une recette à jouer à la main avant publication.

**Écart D-05 levé ici aussi.** `it2-api-commun.mjs` tournait lui aussi sur un cockpit servi en HTTP : la confirmation
d'un choix automatique exige l'en-tête `x-cockpit-confirm: 1`, que les raccourcis `get`/`post`/`put` du client d'API ne
posent pas, d'où deux `fetch` nus réunis dans une seule section. Depuis l'entrée de R105b dans le chantier, `ctx.api.brut`
prend un quatrième paramètre `{ entetes }` : `putAutonomie` et `postExecutionDePlan` passent par le transport du banc,
cookie de session, `origin` et `x-cockpit-csrf` compris. Plus un seul `fetch` nu dans les scénarios de l'itération 2.

**Interrupteur.** `it2-api-interrupteur.mjs` est le seul scénario à deux côtés. Le passage ordinaire du banc le joue
allumé. Pour le côté coupé, l'option `--autonomie-coupee` écrit `COCKPIT_AUTONOMY=off` dans le fichier d'environnement
**du banc**. Poser la variable dans le shell ne coupe rien : le banc retire de l'environnement de docker toute variable
`COCKPIT_*` du shell (protection de R105b), et le compose sert alors `on`.

```sh
scripts/run-e2e.sh --faux --autonomie-coupee --project-prefix i211-e2e --image-tag i211 \
  --scenarios it2-api-interrupteur
```

Par l'API du cockpit :

| Scénario | Ce qu'il établit |
|---|---|
| `it2-api-commun.mjs` | préalables : activation ouverte, interrupteur `COCKPIT_AUTONOMY` allumé, mode Simple par défaut, atelier en place, corpus des 60 bien formé (jamais joué), agents internes installés ; outils communs de la famille |
| `it2-api-modifications.mjs` | la confirmation vient du serveur (428 `confirmation-requise`) ; une écriture dans le dossier part sans demander (règle A-edit, « once » relayé, ligne « Autorisé automatiquement ») ; une écriture dans un fichier protégé attend (règle E2) ; compteurs de la demande ; P4 |
| `it2-api-commandes.mjs` | `grep` et `git status` automatiques dans le dépôt propre (règles A-grep et A-git-status) ; `git status` en attente dans le dépôt piégé (règle G04), sans qu'aucune session de contrôle soit créée ; mesure M4 relevée sur le faux (borne basse) |
| `it2-api-delegation.mjs` | en mode Simple, une délégation conforme sous les plafonds part sans demander (règle A-task) et l'enfant travaille ; seul « once » est relayé |
| `it2-api-plafond.mjs` | plafonds envoyés par la confirmation ; un tour au-dessus du plafond de coût arrête l'arbre, la demande est close « plafond-cout », la conversation revient à « Demander à chaque fois » et plus aucune session n'est occupée |
| `it2-api-lecture-seule.mjs` | assistant « Lecture seule » en Autonome : aucun outil de modification proposé à l'IA, aucune demande `edit` levée, aucun refus d'assistant contourné |
| `it2-api-m14.mjs` | mesure M14 : au signal d'un redémarrage d'opencode (`session.error` sur la session racine), la demande autonome est close « interrompue » et la conversation revient à « Demander à chaque fois » |
| `it2-api-interrupteur.mjs` | `COCKPIT_AUTONOMY` : allumé, les quatre choix sont servis et un `PUT` confirmé passe ; coupé, seuls « Demander » et « Plan d'abord » restent possibles, les deux autres portant la raison `autonomie-coupee` |

Par la page, en agissant comme un utilisateur (clic, clavier), avec captures 1440, 1024 et 400 dans les deux thèmes et
console muette :

| Scénario | Ce qu'il établit |
|---|---|
| `it2-ui-commun.mjs` | préalables et outils de page de l'itération 2 ; une seule entrée de console tolérée, bornée à la route d'autonomie et au code 428, qui est la preuve que la porte du serveur a répondu |
| `it2-ui-selecteur-clavier.mjs` | les quatre choix **et** la confirmation au clavier seul : Entrée n'applique rien toute seule (428), la confirmation porte ses cinq lignes et ses plafonds modifiables, Échap ferme sans rien appliquer, [Lancer en autonome] change le choix côté serveur |
| `it2-ui-plan-autonome.mjs` | plan exécuté en autonome : carte à quatre boutons, 428 puis confirmation, nouvelle conversation créée en « Autonome avec contrôle » avec un brouillon prérempli et rien d'envoyé |
| `it2-ui-bandeau-journal.mjs` | bandeau d'autonomie (compteurs, dépense, plafond, [Arrêter], [Journal]), Journal du contrôle ligne à ligne, puis fin de demande avec [Voir les modifications de cette demande] ; les douze captures des vues de L12 |
| `it2-ui-onglet-ferme.mjs` | onglet fermé pendant une demande autonome : les décisions automatiques continuent et l'attente est retrouvée à la réouverture, bandeau et carte compris |

## Scénario de l'interface de la Salle OMO (chantier 1.1, L26c)

La Salle Oh My OpenAgent est livrée **coupée** (`SALLE_OUVERTE` fausse dans le dépôt). Son interface s'éprouve sur une pile
à part, la **pile de la salle**, en `--faux` seulement :

```sh
scripts/run-e2e.sh --faux --salle --project-prefix sal11-e2e --image-tag sal11
```

- **Salle factice, jamais l'extension.** `e2e/fake-opencode-server.ts` y tourne en trois rôles de plus, tous dans l'image du
  banc (`<préfixe>/app-salle:<étiquette>`, `pull_policy: never`) : `--instance omo`, la salle (le faux opencode avec les
  assistants de l'extension, et un superviseur factice qui parle au cockpit par les fichiers du contrat : état publié,
  battement et `precheck-ok` attendus, `stop-request` et homme mort honorés, relance à neuf) ; `--copilot`, le catalogue du
  compte GitHub Copilot, factice, servi en TLS sous `api.githubcopilot.com` sur le réseau interne ; `--preparer-salle`, joué
  une fois avant le démarrage, sans réseau (certificat du faux catalogue par une autorité jetable de deux jours, gardé dans des
  volumes de la pile et jamais sur l'hôte ; `auth.json` factice ; volume d'état donné à `node`). Les services `opencode-omo`,
  `egress` et `omo-init` du produit changent de profil dans la surcharge : la vraie salle ne peut pas démarrer dans le banc.
- **`SALLE_OUVERTE` basculée dans la copie du banc seulement** (le contexte de construction, hors du dépôt), une seule
  déclaration exigée ; le dépôt la garde fausse, et le scénario le vérifie. `COCKPIT_OMO=on`, un **nom** d'image factice
  (`<préfixe>/salle-factice:<étiquette>`, jamais une image qui existe) et un mot de passe de salle fabriqué à chaque exécution
  sont écrits dans le fichier d'environnement du banc, et nulle part ailleurs.
- **Partage des scénarios.** Avec `--salle`, seuls les scénarios `omo-ui-*` tournent (la pile de la salle n'est pas celle du
  produit) ; sans `--salle`, ils sont écartés et le banc le dit.
- **Gardes.** `--gardes` joue aussi, à part, les gardes de la pile de la salle (bascule dans la copie seule et une seule fois,
  image distincte, `--faux` seul, partage des scénarios, fichier d'environnement, reconfiguration bornée, vraie salle jamais
  démarrée) et en imprime le total sur sa propre ligne.

Dans les scénarios, `ctx.salle` donne `pilote` (relevés de la salle factice, `superviseur()`, `regler({…})` de sa sonde,
`racineEtrangere()`), `workspace` (dossier de travail du banc, hors du dépôt), `projets` et `reconfigurer({ COCKPIT_OMO,
COCKPIT_OMO_IMAGE })`, qui redémarre le cockpit de la pile avec l'un de ces deux interrupteurs changés, et rien d'autre ; il
vaut `null` hors de la pile de la salle. `superviseur()` dit aussi si le cockpit écoute la salle depuis son dernier lancement
(`fluxDepuisLancement`, `fluxApresMs`) : « Salle prête » se lit dans l'état publié, alors que le flux d'événements du cockpit
revient avec un délai croissant (500 ms à 10 s). Chaque étape attend ce rebranchement avant d'agir, et le bilan en donne les
délais relevés.

`omo-ui-salle.mjs` est **un seul fichier**, découpé en étapes : `croisements-it1-v5` n'admet qu'un scénario hors du relevé des
noms `itN-…` et `NNN-…`. Une étape en échec est notée et capturée, la salle est remise en état et les suivantes sont jouées ;
le scénario échoue à la fin en les nommant toutes. `E2E_OMO_ETAPES=<étape>[,<étape>…]` rejoue des étapes seules (les
préalables le sont toujours), par exemple sur une machine chargée.

| Scénario | Ce qu'il établit |
|---|---|
| `omo-ui-salle.mjs` | par étapes, au clavier seul là où la fiche le demande, captures 1440, 1024 et 400 dans les deux thèmes : **préalables** (salle factice prête, catalogue du compte vérifié, `SALLE_OUVERTE` fausse dans le dépôt) ; **simple** : en mode Simple, entrée absente, page inaccessible, aucune requête `/api/omo/*`, et aucun événement de la salle reçu par le flux pendant une relance, alors que la même relance en Avancé en fait arriver ; **entree** : entrée « Salle OMO » atteinte et ouverte au clavier ; **projet-piege** : pré-contrôle refusé, liste masquée (nom du fichier de clés jamais montré), ouverture impossible ; **activation** : champ vide → erreur annoncée et rien d'envoyé, 409 du serveur affiché avec sa phrase et rien d'envoyé, confirmation → bandeau, [Arrêter] → `POST /api/omo/rooms/:rootId/stop`, « Salle en relance » puis « Salle prête », variante Prometheus de l'écran et du tableau « sans demande » ; **fin-de-demande** : [Journal] au clavier, puis relance à neuf et « Salle prête » ; **signales** (§4.14.5, « signalé sans arrêt ») : un `*.ps1` écrit pendant une demande, `omo.signales` reçu par le flux du cockpit en fin de demande, puis le fichier et « à relire avant de lancer sur votre poste » sur la page de la salle, atteints au clavier ; **suspendue** : deux racines créées hors du cockpit → « Salle suspendue », activation refusée avec sa phrase (écran et 409), levée par la réouverture d'une salle, battement repris ; **detection** : `.git` créé pendant une demande → arrêt, quarantaine sur le disque, liste et Journal atteints au clavier à 1440 et 400 px ; **git-attente** (décision A16 point 4) : un `.git` non protégé fait attendre la salle, raison écrite sur la page de la salle et dans le Diagnostic, atteinte au clavier, 409 `git-inscriptible` ; **focus-ecran** (§5.5, « focus jamais volé ») : écran d'activation ouvert, focus sur [Lancer comme Oh My OpenAgent], la page relit l'état de la salle sur un événement du flux, le focus doit rester en place ; **revoir-simple** (Q6, répétition générale « 3s ») : demande brève lancée par l'API, puis, en mode Simple, « Revoir » refusé pendant la demande (`salle-demande-en-cours`) et `…/facts` 403, permis quand elle est finie (lecture 200 « terminée », aucune requête aux deux instances), conversation listée au zoom 1 avec [Revoir cette demande] ; **sans-salle** : `COCKPIT_OMO` coupé puis image absente → entrée absente, puis rétablie ; sur tout le scénario, console muette (seule tolérance : le 409 d'activation provoqué exprès), aucune violation de CSP, P6 et P11 (l'instance principale ne reçoit rien de la salle) et P4 dans la salle |

<!-- [3d] début : scénarios de la salle de contrôle 3D (itération 3, L35) -->
## Scénarios de l'itération 3 : salle de contrôle 3D et « Revoir »

```sh
scripts/run-e2e.sh --faux --scenarios 'it3-' --project-prefix 3d11-e2e --image-tag 3d11
```

`e2e/lib/webgl.mjs` porte les aides 3D. Rien n'y passe par un réglage du cockpit (D-3d-18) : tout se fait par
injection CDP (`Page.addScriptToEvaluateOnNewDocument`), sur une **seconde connexion** au navigateur déjà lancé par le
banc, attachée au même onglet — `e2e/lib/cdp.mjs` n'est pas touché. Deux familles d'injections : les **causes de 2D**
(`simulerWebgl` : refus du contexte demandé avec `failIfMajorPerformanceCaveat`, nom de moteur logiciel) et le
**« moteur simulé »** (`moteurSimule` : drapeau retiré, nom matériel fictif, horloge de la sonde avancée de 12 ms par
image pendant ses 90 images). S'y ajoutent l'écouteur des violations de la CSP, les compteurs d'objets WebGL vivants,
la lecture des marques `salle3d:*`, le journal réseau et l'émulation des réglages du poste (`emuler`).

**Seconde connexion et garde du mouvement.** `preparer3d` fixe d'abord le réglage de l'onglet du banc (garde de R106-b),
puis la seconde connexion pose le jeu complet. Chromium retire l'émulation d'une session qui se détache : la page
retombe alors sur le réglage du **poste**. `cdp.fermer()` repose donc, la connexion fermée, le réglage de l'onglet du
banc : celui fixé par `preparer3d`, ou celui qu'un scénario a changé par `mouvement(…)` du contexte rendu. Un second
appel ne renvoie rien. Sans cela, sur un poste en animations réduites (sessions RDP), la garde relisait `reduce` à la
fin de 5 scénarios `it3-*` sur 6 (répétition générale F1) ; `--poste-mouvement reduce` en est la contre-épreuve.

**Mode 3D du banc**, relu à chaque exécution (`modeBanc`, mesure M3D-1) : contexte *matériel* → aucune injection, la
3D du banc est la vraie ; *logiciel* seulement → « moteur simulé » ; *aucun* `webgl2` → les contrôles 3D sont
consignés « en attente », jamais comptés tenus. **Contrôle non vide** : un scénario où la 3D est attendue exige au
moins une marque `salle3d:scene` **et** le morceau paresseux de three réellement chargé, sinon il échoue.

| Scénario | Ce qu'il établit |
|---|---|
| `it3-salle-controle.mjs` | mode Avancé : délégation scriptée, [Ouvrir la salle de contrôle] depuis la bande, zoom 2 en direct en 3D, « Consigne confiée » (rose) avant « Résultat rendu » (bleu) ; zoom 3 puis zoom 1 par le fil d'Ariane sans aucune marque `salle3d:bascule` ; clavier seul (grille, étiquettes, lecteur) ; zéro violation de CSP et console muette ; à la fermeture, `salle3d:memoire` à géométries 0 et textures 0, et 0 tampon, 0 tableau de sommets, 0 programme WebGL |
| `it3-repli.mjs` | repli 2D : refus du contexte à l'ouverture et **pendant une lecture en différé** (même demande, même moment, même vitesse), moteur « SwiftShader » simulé, mouvement réduit puis [Réessayer] ; chaque cause dit sa phrase, et la 2D dessine aussi ses marques `salle3d:plan` |
| `it3-revoir.mjs` | « Revoir » depuis la bande et depuis les Archives : bandeau, moments « n / N », ← et → au curseur focalisé, les cinq vitesses, badge « EN DIFFÉRÉ ×… · hh:mm:ss », étiquette d'un écart raccourci ; zoom 3 dans la boîte sans texte de message ; [Voir la consigne] depuis une légende et depuis le zoom 3, consigne de 9 000 caractères tronquée ; entre l'ouverture et la fermeture, seulement des `GET /api/revoir/…` (la relecture de sa propre liste par la page du chat, `GET /api/archive` après un classement, comptée à part), rien reçu par le faux sur la conversation revue et aucun appel d'IA hors le classement automatique du cockpit, dépenses inchangées ; vocabulaire du mode Simple |
| `it3-demos.mjs` | les trois démonstrations en Simple et en Avancé sur le lecteur complet, curseur mené au dernier moment au clavier, au moins deux assistants montrés et nommés, avis du mode Simple, zéro requête de la page (la relecture de sa propre liste par la page du chat, `GET /api/archive`, et une reconnexion de son flux comptées à part) et rien de reçu par opencode hors son classement automatique |
| `it3-debit.mjs` | mesure M20 sur la suite dense de `e2e/lib/gen-dense.mjs` (`e2e/fixtures/it3-dense.jsonl` : 50 sessions, 3 niveaux, rafales de 200 événements par seconde rejouées par `POST /banc/emettre`) : au plus 4 marques `salle3d:plan` par fenêtre d'une seconde, au moins une par seconde de rafale, en 3D puis en repli 2D |
| `it3-captures.mjs` | captures (L33) des cinq vues — zooms 1, 2 et 3, « Revoir » avec le panneau de la consigne ouvert (U2, texte long qui défile à 400 px et mention de troncature), démonstration enregistrée — à 1440, 1024 et 400 px, dans les deux thèmes, plus niveaux de gris (`achromatopsia`) et deutéranopie à 1440 ; puis couleurs forcées et mouvement réduit émulés, où la salle passe en 2D **avec sa phrase** et sans canevas ; à 400 px la vue disparaît et la liste reste la vérité ; toutes les images sont écrites dans le dossier du banc, jamais dans le dépôt |

La route de pilotage `POST /banc/emettre` (section `[3d]` de `e2e/fake-opencode-server.ts`, appelée par
`ctx.faux.emettre`) passe une liste d'événements à `faux.emit` : aucun tour n'est joué, aucune IA n'est appelée,
aucun appel n'est facturé. La recette réelle de M20 (capture d'une demande de la Salle OMO) reste en attente.
<!-- [3d] fin -->

<!-- c5:scenarios -->
## Scénarios de l'itération 5 (construction : méthodes, Seconde lecture, chronologie, équipes de la 5b)

```sh
scripts/run-e2e.sh --faux --scenarios c5 --project-prefix c511-e2e --image-tag c511
scripts/run-e2e.sh --faux --scenarios c5a- --project-prefix c511-e2e --image-tag c511
scripts/run-e2e.sh --faux --scenarios c5b- --project-prefix c511-e2e --image-tag c511
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
| `c5b-relecture.mjs` | forme RELECTURE de bout en bout sur « Compte rendu d'incident relu » (`postmortem`) : premier jet, pause avant la relecture (aucun envoi pendant), verdict lu sur la DERNIÈRE ligne à l'octet, second tour, PLAFOND de tours respecté (le relecteur ne relit pas trois fois ; la dernière correction part sans être relue) et notes « Relecture non conclue après 2 tours … » et « Non relue après la dernière correction. » ; sessions REPRISES (D-5-14) : exactement deux `POST /session` pour le bloc, cinq envois dedans ; journal de relecture REPLIÉ sous le résultat (rien de rendu à l'écran tant qu'il est replié) avec ses deux tours et leurs relectures ; coût égal à la somme des cinq appels scriptés, sous le plafond d'arrêt du lancement |
| `c5b-aiguillage.mjs` | forme AIGUILLAGE sur « Tri d'une alerte » (`tri-alerte`), deux lancements : (1) l'aiguilleur propose, le lancement attend, AUCUN spécialiste n'est lancé et aucun envoi ne part avant la confirmation ; la carte de choix se tient au clavier (case cochée puis décochée par la barre d'espace, [Continuer] actionné au clavier) ; les écartés passent à « Non choisi », sans coût ; (2) chemin « aucun ne convient », choisi AU CLAVIER sur la carte : rien n'est envoyé, le livrable porte la phrase du refus, et [Envoyer à cet assistant] PRÉREMPLIT le composeur — la demande ET l'assistant de repli — sans rien envoyer ni facturer |
| `c5b-schema.mjs` | SCHÉMA MODIFIABLE, dans un navigateur propre au scénario (frappes et pointeur réels, par CDP) : bascule ouverte au clavier ; Alt+↓ et Alt+↑ VRAIS déplacent un bloc (suivi dans [Voir le JSON]) ; un lien se pose par le menu « Reçoit le résultat de… » (Entrée ouvre, barre d'espace coche : `recoit: {etapes}`) ; lien VERS LE HAUT : au clavier il ne peut pas être demandé (chaque menu ne propose que des étapes plus hautes, mesuré sur tous les menus), et le seul geste qui le demande — le glisser depuis le port de sortie d'une étape vers une étape plus haut, joué au pointeur — est REFUSÉ avec la phrase « Le cockpit exécute les étapes de haut en bas … » écrite près de la cible avec son icône, pendant le survol et après la relâche, ANNONCÉE par la région polie de la page, sans rien écrire dans le déroulé ; un déplacement qui rendrait un lien arrière ne le garde jamais en silence ; [Voir le JSON] en lecture seule ; à 899 px la phrase de la spécification, à 900 px le schéma ; rien n'est enregistré |
| `c5b-vue-ensemble.mjs` | VUE D'ENSEMBLE de la carte des assistants : absente en mode Simple ; huit puces de filtre, une par groupe et le même libellé pour les deux ; une puce éteinte RETIRE son groupe (elle ne l'estompe pas) et le rend au rallumage, dans le même ordre ; un nœud est un vrai bouton : Entrée donne le focus à un nœud qui ne l'avait pas (un seul nœud le porte), Échap le retire ; tout ce qui est estompé — nœuds et liens — dit « (hors sujet) », et rien d'autre ne le dit ; connecteurs SVG décoratifs, liens repris en toutes lettres |
| `c5b-demonstration.mjs` | ÉQUIPES FERMÉES EN SIMPLE sans aucune bascule : phrase de l'itération 4, pas de galerie, pas de [Voir une démonstration], liste des équipes installées en LECTURE SEULE (aucune commande vers l'éditeur ni l'installation), pas d'éditeur, pas de lanceur, avis de délégation COURT ; les six exemples livrés passent la grammaire du mode Simple ; l'ouverture en UNE ligne est jouée quand la pile est bâtie depuis la copie jetable (`ouvertesEnSimple`) : lanceur, galerie, démonstration (ouverte), éditeur guidé et avis complet — sinon dite et non jouée ; DÉMONSTRATION d'équipe en Avancé, mouvement réduit posé AVANT l'ouverture : lecteur pas à pas, carte et Déroulé sous la bande, « Déroulé enregistré avec des données fictives. », AUCUNE lecture automatique ni animation perceptible, un moment de plus au clavier ; ZÉRO requête de la page et ZÉRO requête reçue par opencode hors le fond permanent (journal du faux, mesure de `sansRequete` reprise si une relecture d'archive du cockpit tombe dans la fenêtre, classement automatique coupé le temps de la mesure) |
| `c5b-couts-archives.mjs` | ce qu'une équipe laisse derrière elle : Déroulé d'équipe d'une relecture faite en un tour (« Prévu : jusqu'à 2 tours · Réel : 1 tour ») ; aiguillage à un choix, spécialistes non retenus « Non choisi », sans coût, dans le Déroulé d'équipe du panneau de contexte, dans celui de la fiche d'Archives ET dans la ligne d'étape de la section « Équipes lancées dans cette conversation » ; filtre « Avec une équipe » ; ligne « Par équipe » des Coûts avec ses cinq colonnes ; colonnes `lancement_equipe` et `etape` à la fin de l'en-tête du CSV, et au moins une ligne qui les porte ; Seconde lecture d'un RÉSULTAT D'ÉQUIPE, chiffrée, sans « au moins », EN DERNIER sous la carte, et son clic au clavier : UN envoi au Relecteur critique, dans la conversation de l'équipe, avec la phrase exacte de la cible « équipe » ; onglet Méthodes et sa bibliothèque. Un écart du produit relevé en chemin n'arrête pas le scénario : le reste est éprouvé, puis il tombe en le nommant |
| `c5b-a11y.mjs` | banc de captures d'accessibilité de la 5b : dix vues (galerie, éditeur en « Étapes » puis en « Schéma modifiable », carte de choix, carte d'exécution, carte de résultat, Déroulé d'équipe, chronologie d'un lancement, vue d'ensemble, onglet Méthodes) × 3 modes × 2 thèmes × 3 tailles = 180 fichiers, chaque vue RELEVÉE juste avant sa capture (sous 900 px, le schéma montre sa phrase et c'est elle qui est exigée) ; en mouvement réduit, zéro animation perceptible à CHAQUE capture de ce mode (dix vues × 2 thèmes × 3 tailles), puis au repos ; en contraste forcé, focus visible sur une puce de filtre et sur une ligne du schéma ; console muette |
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

### Les équipes de la 5b sur le banc (`c5b-*`)

Les scénarios d'équipe tournent en **mode Avancé** : les équipes sont fermées en mode Simple tant que
`EQUIPES_SIMPLE_OUVERTES` (`app/server/wiring-eq.ts`) vaut `false`, et elle vaut `false` **dans le dépôt** (décision U1).
`c5b-demonstration.mjs` éprouve cette fermeture telle quelle, sans rien basculer. L'**ouverture en une ligne** se joue
dans une **copie jetable** tirée de la tête par `git archive`, jamais dans le dépôt ni dans le dossier de travail : la copie
reçoit son propre `git init` (le banc prépare son contexte par `git ls-files`), son arbre doit être EXACTEMENT celui de la
tête, puis une seule ligne y est basculée et le diff doit n'en compter qu'une. Le banc est lancé depuis la copie, qui
est supprimée à la sortie, réussite ou échec.

La procédure s'arrête au **premier échec**, en le disant, et n'agit jamais sur le dossier courant : tout passe par
`git -C "$copie"` et par des chemins sous `"$copie"`. La copie est un dossier **neuf** (`mktemp -d`, sous `$TEMP`, à
défaut `$TMPDIR`, à défaut `/tmp`) : une copie laissée par un passage précédent n'est jamais reprise. Si le dossier ne
peut pas être créé, rien d'autre ne se fait ; si la copie n'est pas la tête, si la bascule ne touche pas exactement une
ligne, ou si l'état du dépôt a changé pendant la procédure, le banc n'est pas lancé. À lancer depuis le dépôt :

```sh
( set -euo pipefail
  depot="$(git rev-parse --show-toplevel)"
  etat_depot="$(git -C "$depot" status --porcelain=v1)"
  arbre_tete="$(git -C "$depot" rev-parse 'HEAD^{tree}')"
  copie="$(mktemp -d "${TEMP:-${TMPDIR:-/tmp}}/c511-ouverture-u1.XXXXXX")"   # dossier NEUF, hors du dépôt
  trap 'cd / && rm -rf -- "$copie"' EXIT                                     # la copie est supprimée à la sortie
  git -C "$depot" archive --format=tar HEAD | tar -x -C "$copie"
  git -C "$copie" init -q
  git -C "$copie" add -A
  test "$(git -C "$copie" write-tree)" = "$arbre_tete" || { echo "copie différente de la tête" >&2; exit 1; }
  sed -i 's/^export const EQUIPES_SIMPLE_OUVERTES = false;$/export const EQUIPES_SIMPLE_OUVERTES = true;/' "$copie/app/server/wiring-eq.ts"
  test "$(git -C "$copie" diff --numstat)" = "$(printf '1\t1\tapp/server/wiring-eq.ts')" || { echo "la bascule ne touche pas exactement une ligne" >&2; exit 1; }
  test "$(git -C "$depot" status --porcelain=v1)" = "$etat_depot" || { echo "le dépôt a changé : banc non lancé" >&2; exit 1; }
  cd "$copie"
  scripts/run-e2e.sh --faux --scenarios c5b-demonstration --project-prefix c511-e2e --image-tag c511
)
```

Le scénario lit alors `ouvertesEnSimple` de `GET /api/teams` et éprouve, EN SIMPLE et sans autre changement, le lanceur,
la galerie (les exemples, valides en Simple), la démonstration (ouverte), l'éditeur guidé et l'avis complet de
délégation. Même avertissement que `it4-simple-ouvert.mjs` : sans la copie basculée, la partie « ouverture » ne vérifie
rien tout en comptant vert — le scénario le **dit** dans son relevé. L'annonce de la 1.1.0 n'est pas vérifiée ici (L51).

Les assistants d'un déroulé de la 5b sont déclarés au faux par `declarerLesAssistants` / `declarerNoms`
(`c5b-relecture.mjs`, qui les exporte) : `declarerAssistants` de `it4-commun.mjs` ne connaît que les blocs `etape`,
`avis` et `pause`, et un bloc `relecture` ou `aiguillage` ne lui montre aucune étape — le pré-lancement refuserait alors
l'équipe en « assistant-absent ». L'aide de l'itération 4 est appelée telle quelle, avec un déroulé de la forme qu'elle
connaît (une étape par assistant distinct) qui ne sert qu'à nommer les assistants ; le déroulé réel n'est jamais modifié.
Un agent du déroulé que le faux sert SANS les règles de son fichier (lecture seule) y est redit avec elles, les autres
agents restant tels quels : `c5a-seconde-lecture.mjs` déclare le « Relecteur critique » par `banc:agents` sans aucune
règle, ce qui vaut « tout permis » pour opencode, et l'étape de relecture de `postmortem` serait alors refusée en
« delegue » et « internet » quand les deux familles tournent sur la même pile (`--scenarios c5`). Le vrai opencode, lui,
lit le fichier installé.
Pour la même raison, la copie d'un exemple en équipe propre à un scénario (identifiants suffixés) est refaite dans les
scénarios qui en ont besoin : `equipeDerivee` de l'itération 4 rendrait un bloc de la 5b en pause.

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
