# Captures réelles d'opencode 1.18.30

Événements enregistrés le 2026-09-14 par l'expérience « ocgraph » : un conteneur opencode 1.18.30 isolé, un modèle gratuit (`opencode/big-pickle`, coût 0) et un espace de travail factice (`/workspace`).

Lues par `readCapture()` dans `../fake-opencode.ts`. Format : une ligne JSON par événement, `{"recv": <heure de réception locale en ms>, "event": <bloc SSE>}`.

| Fichier | Flux | Scénario | Événements |
|---|---|---|---|
| `p1-delegation-parallele.jsonl` | `/event` | création de la racine, puis deux `task` en parallèle, dont un demandé et accordé « once » ; synthèse ; repos à 31,5 s | 259 |
| `p2-commande-subtask.jsonl` | `/event` | commande `revue-croisee` (`subtask: true`) : message repère, enfant sans demande, reprise, `command.executed` | 80 |
| `p6-arret-global.jsonl` | `/global/event` | arrêt pendant qu'un enfant travaille et qu'une seconde délégation attend son autorisation ; jumeaux `sync` compris | 83 |
| `p7-autorisation-orpheline.jsonl` | `/event` | « once » tardif sur la demande restée en attente : sous-agent détaché, parent jamais repris | 55 |

Les fichiers du flux `/event` n'ont ni enveloppe `{directory, project}` ni jumeaux `sync`. `readCapture()` ajoute l'enveloppe (`/workspace`, `global`) sans créer de jumeaux.

## Outils envoyés au modèle (mesure M2)

`m2-tools.json` : listes d'outils relevées le 2026-09-14 par la mesure M2 (opencode 1.18.30 hors ligne, faux fournisseur compatible OpenAI qui enregistre les outils de chaque requête), pour 5 cas : sans règle, racine avec `edit` et `bash` refusés, enfant `general` de cette racine, `* deny` avec lecture permise, `PATCH` d'un refus de `bash`. Chaque cas donne l'agent, les règles envoyées à la création ou par `PATCH`, les règles relues sur la session et la liste triée des outils ; `configPermission` reprend la clé `permission` de la configuration du banc. Généré depuis la sortie brute (`m2-result.json`) après vérification que chaque requête d'un même cas voit la même liste, puis la recherche du paragraphe « Nettoyage » : aucune occurrence. Rejoué par `fake.toolsFor()` dans `fake-opencode.test.ts`.

## Mesures hors ligne MX1

`mx1-mesures.json` : relevés du 2026-09-15 de la mesure MX1 (opencode 1.18.30 hors ligne, faux fournisseur compatible OpenAI, IA `mock-1` et `gpt-5-mock` ; compte rendu `execution/mesures/MX1.md` du chantier 1.1, passe A, passe B identique). Trois parties :
- `metadata` : demandes `edit`, `write` et `apply_patch` (ajout, modification, suppression, déplacement, patch multiple), dans un dossier git et hors git (worktree `/`) ; pour chaque cas, l'entrée exacte de l'outil, la liste d'outils proposée et la demande relevée (`permission`, `patterns`, `always`, `metadata`) ; `files` donne le contenu des fichiers témoins ;
- `m14` : `POST /global/dispose` pendant une demande `bash` en attente : suite des événements de la session occupée jusqu'à `global.disposed`, état d'après, `once` tardif (404, identifiant remplacé par `<id>`) ; `ids` garde un échantillon d'identifiants réels ;
- `tools` : listes d'outils de M16 (plancher à la création et par `PATCH`) et de M3 (témoin, `read mcp:*`, ETAPE, `read *`), avec les règles envoyées.

Générée par le train it1 V0 depuis les sorties brutes (`out/passe-a`, comparée à `out/passe-b`), après vérification des empreintes du banc (contenus, plancher, règles ETAPE) et la recherche du paragraphe « Nettoyage » : aucune occurrence. Rejouée par `croisements-it1-v0.test.ts` (métadonnées par défaut, suite d'arrêt et `toolsFor()` du faux, relais du proxy).

## Mesures hors ligne MX2

`mx2-mesures.json` : relevés du 2026-09-17 de la mesure MX2, scénario « F-l » (opencode 1.18.30 hors ligne, faux fournisseur, `bash: ask`, dossier `/workspace/fl` ; compte rendu `execution/mesures/MX2.md` du chantier 1.1, passe A). Une session par forme ; pour chacune, la commande exacte, la permission demandée pour la partie `bash` (`asked`, `null` quand la partie s'est terminée **sans aucune demande** pour son `callID`) et, le cas échéant, `ecrit` quand la forme a modifié le disque sans demande.

29 formes : 21 sans demande (dont 5 qui écrivent : `declare -p > f`, redirection seule dans une boucle ou un sous-shell, `cd sub && > f`, `> ~/.gitconfig`), 7 avec une demande `bash` et une avec une demande `external_directory` (`cd /tmp`). La liste du §3.3 de la spécification (affectation, `declare`, redirection seule) reste vraie mais est **plus étroite** que la réalité mesurée. Correction portée par la mesure : « `echo a > f` » n'est **pas** une forme sans demande ; la forme sans demande est la redirection **seule**.

Rejouée par `croisements-it2-v0.test.ts` : contre `isNoRequestShellForm` et la porte shell (`shared/shell-gate.ts`), et sur le faux opencode, où chaque forme sans demande termine sa partie `bash` sans `permission.asked` pour son `callID` — le fait runtime dont L10c fait sa condition principale.

Les autres mesures de MX2 (M5 : partie `bash` publiée avant l'effet disque, mais prévention impossible ; M11 : configuration git globale du conteneur opencode, illisible par le cockpit) ne donnent pas de fixture : leur conséquence est une phrase de la spécification et une limite à documenter (DOC2, « G04 limité au dépôt »).

## Réductions

- p1 et p2 : fenêtres extraites de la capture continue p1-p5, du début de la capture au repos de la racine (p1), puis de l'envoi à `command.executed` (p2).
- Deltas `message.part.delta` : seuls le premier et le dernier de chaque partie sont gardés (963 retirés au total). Le texte complet reste dans le `message.part.updated` final de chaque partie.
- JSON réécrit sans espaces ; aucune valeur modifiée.
- Total : 229 724 octets.

## Nettoyage

Recherche automatique avant copie :
- jetons, `Basic`, `Bearer`, `Authorization`, mots de passe, clés (`gh*_`, `github_pat_`, `sk-`, JWT, clés privées) ;
- adresses e-mail, adresses IP, `localhost` ;
- chemins d'hôte Windows (`C:\`, `/c/Users`, `AppData`) et nom d'utilisateur.

Résultat : **aucune occurrence**, rien n'a été remplacé. La capture passait par le port publié et l'en-tête d'authentification n'était jamais écrit. Les seuls chemins présents sont ceux du conteneur (`/workspace/...`).

Les contenus factices (journaux `app.log`, `worker.log`, `changements.md`) et les identifiants `ses_`, `msg_`, `prt_`, `per_`, `evt_` sont gardés tels quels : ils ne donnent accès à rien, et leurs horodatages sont nécessaires aux tests.

Le test `fake-opencode.test.ts` refait cette recherche à chaque exécution, avec ces motifs : `Authorization`, `Basic`, `Bearer` et `password` ; jetons `gh[oprsu]_` et `github_pat_` ; clés `sk-` ; JWT (`eyJ…`) ; clés privées ; adresses e-mail ; adresses IPv4 ; `localhost` ; chemins d'hôte (`C:\`, `/Users/`, `AppData`) ; nom de l'utilisateur qui lance les tests. Ce nom est lu sur la machine, jamais écrit dans le dépôt, et ignoré s'il fait moins de 4 caractères ou si c'est un compte générique (`root`, `node`, `runner`…). Un second test vérifie que chaque motif détecte un exemple planté.
