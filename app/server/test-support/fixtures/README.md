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

Le test `fake-opencode.test.ts` refait cette recherche à chaque exécution.
