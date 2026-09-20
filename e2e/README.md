# Banc e2e du cockpit

Bout en bout, sur une pile Docker **jetable**, isolée de celle de l'utilisateur. Aucune dépendance npm : Node 24
apporte `fetch` et `WebSocket`, Docker monte la pile, et un navigateur déjà installé (Edge ou Chromium) est piloté par
le protocole CDP. Rien ici ne tourne en intégration continue (décision D-06) et rien n'entre dans l'image du cockpit.

```sh
scripts/run-e2e.sh                        # mode --faux : cockpit + faux opencode
scripts/run-e2e.sh --scenarios 000-smoke  # un seul scénario
scripts/run-e2e.sh --gardes               # vérifie les refus d'isolation, sans Docker
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
  message d'erreur, ni dans l'adresse de la page (le banc ouvre la session par `POST /api/login`, jamais par
  `/auth?t=`).

Le cockpit sert en **HTTP** tant que la 1.0.5 n'est pas rebasée (décision D-05). Le rebase (paquet R105) passera le
banc en HTTPS épinglé (`--pinnedpubkey`, jamais `-k`) et renommera le cookie. Les endroits à reprendre portent la
mention `D-05` : deux dans `e2e/lib/cockpit.mjs`, les autres dans les scénarios de l'itération 1
([liste](#scénarios-de-litération-1-chantier-11)) et dans `it2-api-commun.mjs`
([liste](#scénarios-de-litération-2-chantier-11)).

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
| `navigateur` | l'onglet piloté : `aller`, `evaluer`, `attendreQue`, `texte`, `cliquer`, `taper`, `touche`, `focus`, `taille`, `theme`, `capture`, `journalReseau` |
| `url` | adresse du cockpit de la pile jetable |
| `faux` | pilotage du faux opencode (`requetes`, `evenements`, `scripter`, `tourParDefaut`, `oublier`), ou `null` hors du mode `--faux` |
| `mode` | `faux`, `reel-hors-ligne` ou `reel` |
| `api` | client d'API du cockpit, déjà connecté (`get`, `post`, `put`, `brut`) |
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
| `e2e/lib/docker-e2e.mjs` | gardes d'isolation, pile Compose, déroulé, et leurs propres vérifications (`--gardes`) |
| `e2e/lib/cdp.mjs` | navigateur sans fenêtre, profil temporaire neuf, captures, clavier, console, journal réseau |
| `e2e/lib/cockpit.mjs` | santé, session, client d'API, relevés du faux |
| `e2e/lib/faux-fournisseur.mjs` | faux fournisseur compatible OpenAI (mode `--reel-hors-ligne`) |
| `e2e/lib/opencode-hors-ligne.jsonc` | configuration d'opencode pour ce mode (levier de M-B1) |
| `e2e/fake-opencode-server.ts` | le faux opencode des tests, servi dans la pile jetable |
| `e2e/docker-compose.e2e.yml` | surcharge d'isolation, jamais utilisée seule |
| `e2e/scenarios/` | les scénarios ; `000-smoke.mjs` vérifie le banc lui-même |

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

**HTTP (écart D-05).** Ces scénarios supposent un cockpit servi en HTTP, à des endroits marqués `D-05` :
`it1-api-commun.mjs` (flux d'événements du témoin P6 lu par un `fetch` brut vers `ctx.url`), `it1-ui-commun.mjs`
(adresse en `http://`, CSP lue par un `fetch` brut, page exigée en `http:`) et `it1-ui-m25.mjs` (CSP lue par un
`fetch` brut, page exigée en `http:`). Ils sont à reprendre au rebase de la 1.0.5, en plus des deux endroits de
`e2e/lib/cockpit.mjs` : un banc en HTTPS épinglé refuse un `fetch` sans épinglage.

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
| `it1-ui-commun.mjs` | préalables : mode Simple par défaut, page en HTTP sous la CSP réelle (D-05), règles acceptées au clic, flux d'événements ouvert ; relevés installés dans la page (faisceaux, animations, violations de CSP) |
| `it1-ui-delegation.mjs` | mode Avancé, demande posée quelques millisecondes après la partie `task` comme sur opencode réel (`askAfterMs` du faux) : carte « Détails de la délégation » ; sans aucun clic pendant la demande, carte des agents et « Qui travaille ? » dépliés, attente de votre accord (hexagone hachuré, cadenas, ambre) et préparation (pointillé rose fixe) visibles dans la fenêtre, titre, lignes et [Répondre] de « Qui travaille ? » vus (elementFromPoint, pas seulement rendus) ; « Autoriser une fois » cliqué, faisceau rose (préparation, consigne) puis bleu (résultat), dans l'ordre des faits |
| `it1-ui-arreter.mjs` | « Arrêter » visible pendant le travail délégué ; le clic arrête tout l'arbre et la consigne est figée en gris |
| `it1-ui-mise-en-page.mjs` | mode Avancé, délégation en attente puis en cours, à 1440, 1280, 1024 et 400 px : fil et « Qui travaille ? » visibles, « Autoriser une fois », « Refuser… » et « Arrêter » dans la fenêtre et non recouverts (elementFromPoint), [Répondre] atteignable (au besoin en faisant défiler la seule région d'activité), zone principale jamais défilée, « Contexte » fermé de lui-même sous 1280 px ; carte des agents dépliée pendant la demande ; tout relevé vu (elementFromPoint) : titre de « Qui travaille ? » vu sans défiler aux quatre tailles, ses lignes et [Répondre], l'attente de votre accord et la préparation vues sans défiler à 1440 et 1280, atteintes en faisant défiler la région et la bande à 1024 × 768 (la saisie y prend 428 px), bandeau d'une ligne et [Répondre] vus à 400 ; [Répondre] focalise « Autoriser une fois » ; modification en attente sur la racine, à 1440 : « Qui travaille ? » et l'attente de votre accord vus sans défiler |
| `it1-ui-demonstration.mjs` | démonstration en Simple puis en Avancé : étiquette, avis du mode Simple, tous les moments parcourus, zéro requête de la page et d'opencode |
| `it1-ui-p2-raccourci.mjs` | capture p2 : délégation d'un raccourci `subtask` lancée sans demande, enregistrée « sans confirmation », et « lancé sans confirmation » affiché |
| `it1-ui-m25.mjs` | mesure M25 en HTTP : CSP servie, flux d'événements, transitions WAAPI de 900 ms jouées une fois, aucune violation |
| `it1-ui-selecteur-clavier.mjs` | sélecteur « Autonomie » au clavier seul (APG), jusqu'à la création de « Plan d'abord (nouvelle conversation) » par Entrée ; le focus reste sur le bouton du sélecteur dans la conversation de plan |
| `it1-ui-m1-noreply.mjs` | mesure M1 : recette facturée, jouée seulement en `--reel` avec `E2E_ACCORD_FACTURE` (en attente) ; ailleurs, une répétition sans IA réelle (deux envois `noReply` sans tour, puis une réponse) |

## Scénarios de l'itération 2 (chantier 1.1)

L'itération 2 est « l'autonomie contrôlée ». Ses scénarios se lancent comme ceux de l'itération 1 :

```sh
scripts/run-e2e.sh --faux --scenarios 'it2-*' --project-prefix i211-e2e --image-tag i211
scripts/run-e2e.sh --reel-hors-ligne --scenarios 'it2-*' --project-prefix i211-e2e --image-tag i211
```

Mêmes règles que pour l'itération 1 : un fichier `*-commun.mjs` porte les outils de sa famille et vérifie ses
préalables, et chaque scénario qui agit sur opencode le fait sous le témoin P6 et P4 (`avecTemoinP6` d'
`it1-api-commun.mjs`).

**Atelier.** L'autonomie décide sur des faits du disque : les règles de modification résolvent les chemins et la porte
des commandes lit le sous-arbre et `.git/config`. `it2-api-commun.mjs` prépare donc, une seule fois, deux petits dépôts
dans le dossier de travail monté par le banc : `it2-atelier` (dépôt propre) et `it2-piege` (dépôt dont le `.git/config`
porte `core.pager`, ce qui fait attendre toute commande `git` — règle G04).

**Corpus de la barrière des 60.** `e2e/corpus/controle-60.json` porte les soixante commandes de la recette M8 (trente
inoffensives, trente nuisibles). Le banc en vérifie seulement la **forme** à chaque passage ; **aucune de ces commandes
n'est soumise**, ici ni ailleurs : la barrière est une recette à jouer à la main avant publication.

**HTTP (écart D-05).** `it2-api-commun.mjs` suppose lui aussi un cockpit servi en HTTP : la confirmation d'un choix
automatique exige l'en-tête `x-cockpit-confirm: 1` et le client d'API du banc ne sait pas poser d'en-tête. Ses deux
`fetch` bruts vers `ctx.url` sont réunis dans une seule section « Requêtes brutes (D-05) », et sont à reprendre au
rebase de la 1.0.5 comme ceux de l'itération 1.

**Interrupteur.** `it2-api-interrupteur.mjs` est le seul scénario à deux côtés. Le passage ordinaire du banc le joue
allumé. Pour le côté coupé, la variable se pose dans l'environnement du shell — Compose l'interpole avant le fichier
d'environnement du banc, donc aucun fichier n'est à modifier :

```sh
COCKPIT_AUTONOMY=off scripts/run-e2e.sh --faux --project-prefix i211-e2e --image-tag i211 \
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
- **Un scénario échoue sans raison claire** : la capture `<scénario>-echec.png` est dans le dossier des captures,
  affiché à la fin de l'exécution.
