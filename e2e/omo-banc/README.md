# Banc de la Salle Oh My OpenAgent (hors ligne et complet)

Ce banc monte **la vraie salle** — l'image `opencode-omo` (opencode 1.18.30 + Oh My OpenAgent 4.19.4), le compose du produit,
le superviseur, le proxy de sortie — sur un réseau **fermé**, devant un **faux** GitHub Copilot. Il a deux modes :

- **hors ligne** (L21, défaut) : trois pilotes tiennent la place du cockpit pour le battement, l'authentification et le
  pré-contrôle ; le banc joue les portes `git`, G1, G2, G9 (pilote), G12, G14, SUL et `sup`, les mesures du plan, et le relevé
  M28 des automatismes gardés (`hooks`) ;
- **complet** (L21b, `--complet`) : le **cockpit réel**, bâti depuis une copie `git archive` du dépôt avec `SALLE_OUVERTE`
  basculée **dans cette copie seulement**, devant une instance principale réelle sur un faux fournisseur, le tout sur un réseau
  fermé ; il joue la fumée du cockpit réel, puis les portes de `portes/` (L27a, L27b).

Il ne coûte rien et ne sort nulle part : l'`auth.json` posé est factice, son `expires` est lointain (aucun aller-retour vers
`api.github.com`), et le seul hôte que le proxy de sortie accepte est détourné vers le faux fournisseur.

---

## 1. Avant de lancer

1. **Docker Desktop** tourne.
2. Les deux images du banc existent (elles ne sont ni publiées ni tirées : on les construit à la main) :

   ```powershell
   # image opencode du cockpit, étiquetée pour le banc
   docker build --provenance=false -f docker/opencode/Dockerfile -t sal11/opencode:sal11 .

   # image de la salle : voir « Construire l'image de la salle » ci-dessous
   # image du cockpit, employée par les pilotes et le proxy de sortie
   docker build --provenance=false -f app/Dockerfile -t sal11-omo/app:sal11 .
   ```

3. Rien d'autre. Le banc fabrique lui-même ses certificats, ses projets jetables, son mot de passe et son fichier
   d'environnement, dans un dossier **hors du dépôt** (`%TEMP%\sal11-omo-banc\<projet>-<horodatage>`).
4. Mode complet seulement : l'image du cockpit réel est **bâtie par le banc** (`cockpit/preparer.mjs` : `git archive` de
   `--ref`, bascule de `SALLE_OUVERTE` dans la copie, `docker build -f app/Dockerfile`, donc `npm ci` avec Internet, aucun appel
   Copilot) sous `sal11-omo/cockpit-reel:sal11` ; l'instance principale emploie `sal11/opencode:sal11` ci-dessus.

### Construire l'image de la salle

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-omo-image.ps1 `
  -BaseImage <image opencode>@sha256:<64 hex> -OutDir <dossier hors du dépôt> -AcceptManifest
docker tag opencode-cockpit/opencode-omo:4.19.4-<horodatage> sal11-omo/opencode-omo:sal11
```

> **Piège mesuré.** `-BaseImage` exige une empreinte, et BuildKit résout une empreinte **auprès d'un registre**, jamais dans
> le magasin local : une image construite sur place ne peut pas être citée par `nom@sha256:<identifiant>`. Il faut donc lui
> donner une **empreinte de dépôt**, par exemple en la poussant d'abord vers un registre local jetable
> (`docker run -d --name sal11-omo-banc-registry -p 127.0.0.1:5111:5000 registry:2`). Le manifeste écrit par `-AcceptManifest`
> est lié à cette empreinte de base : changer d'image de base impose de relancer `-AcceptManifest`.

---

## 2. Lancer

```bash
# à blanc : commandes affichées, refus vérifiés, aucune commande Docker
node e2e/omo-banc/run-banc.mjs --a-blanc

# le cas réel : projets avec de vrais dépôts git (depuis L16c, la salle démarre aussi sur un hôte Windows, §5.1)
node e2e/omo-banc/run-banc.mjs --id defaut --scenarios git,g2 --duree-g1-min 1

# banc complet, avec de vrais dépôts
node e2e/omo-banc/run-banc.mjs --id l21 --duree-g1-min 30 \
  --image-base 127.0.0.1:5111/<dépôt>/opencode@sha256:<64 hex>

# une porte seule, en abrégeant G1
node e2e/omo-banc/run-banc.mjs --id l21 --scenarios g2,g9 --duree-g1-min 1

# banc COMPLET : cockpit réel bâti depuis HEAD, battement par les pilotes du banc (voir §2.3)
node e2e/omo-banc/run-banc.mjs --id fumee --complet --battement-banc

# banc complet sur une autre tête (par exemple celle du train de la vague 4)
node e2e/omo-banc/run-banc.mjs --id fumee --complet --battement-banc --ref chantier/1.1-salle
```

| Option | Rôle |
|---|---|
| `--a-blanc` | n'appelle jamais Docker : affiche les commandes, vérifie les refus et la présence des fichiers ; en mode complet, dit aussi ce que la tête du dépôt livre au cockpit réel (bascule, activation, battement) |
| `--id <id>` | identifiant du banc ; le projet Compose vaut `sal11-omo-banc-<id>` |
| `--scenarios` | hors ligne : `git,g1,g2,g12,g9,mes,hooks,g14,sul,sup` (défaut : tous, dans cet ordre ; `sup` supprime une entrée fichier et une entrée dossier du projet jetable, relance la salle par la politique `restart` puis par `compose restart`, et vérifie côté poste que rien n'est recréé : elle laisse la salle arrêtée, donc toujours en dernier) ; complet : `cockpit-fumee` puis les portes de `portes/` |
| `--duree-g1-min` | durée des scénarios scriptés de G1 (défaut : 30 minutes, comme la porte le demande) |
| `--image`, `--image-app`, `--image-base` | images employées ; `--image-base` déclenche l'auto-test `-SelfTest` de G14 |
| `--contournement` | ajoute `banc-contournement.compose.yml` — **défaut du produit reproduit**, voir §5 |
| `--sans-git` | projets préparés **sans dépôt** : banc DÉGRADÉ (porte `git` sans objet, M23 non mesurable) ; ne remplace jamais une exécution avec de vrais dépôts (§2.1) |
| `--complet` | banc COMPLET : cockpit réel jetable au lieu des pilotes (`cockpit/`), réseau du projet fermé (§2.3) |
| `--ref <commit>` | mode complet : commit d'où bâtir le cockpit réel (défaut `HEAD`) ; branche, étiquette ou SHA, jamais un texte qui commence par `-` |
| `--image-cockpit <réf>` | mode complet : image du cockpit réel déjà bâtie ; ce qu'elle livre n'est pas lisible, elle est tenue pour « non livrée » (la fumée dit alors « en attente » plutôt qu'un faux vert) |
| `--battement-banc` | mode complet : les pilotes du banc déposent la liste des projets et écrivent le battement, parce qu'aucun code de production n'appelle encore `startHeartbeat()` (§2.3) ; le bilan le dit |
| `--projets-test <liste>` | recopie les projets de test `g7`, `g13` (`projets/`) comme projets préparés, pour les portes G7 et G13 (L27a, L27b) ; `g7` est piégé : le pré-contrôle réel refuse alors le démarrage (portée « prepares ») |
| `--garder` | ne nettoie pas à la fin (diagnostic) ; le verrou est rendu, le projet reste à retirer à la main |
| `--base <dossier>` | dossier de travail du banc, hors du dépôt |
| `--ecrire-fixtures` | **remplace les fixtures du dépôt** par les captures du scénario `mes` ; sans cette option le dépôt n'est jamais touché |

**Le banc ne salit jamais la copie de travail.** Le scénario `mes` capture trois flux réduits
(`omo-banc-m20.jsonl`, `omo-banc-m21.jsonl`, `omo-banc-r16.jsonl`). Par défaut ils vont dans `<dossier>/sortie/`, à côté des
autres relevés, et `git status` reste vide après un banc. Les fichiers de même nom sous
`app/server/test-support/fixtures/` sont les fixtures **commitées** : elles ne sont remplacées que sur `--ecrire-fixtures`,
et le banc dit alors, ligne par ligne, quel fichier du dépôt il a réécrit. Après un tel banc, relire le `git diff` avant de
commiter : chaque exécution change les identifiants de session et tous les horodatages, soit ≈ 260 lignes de bruit.

Le banc rend `0` si toutes les portes jouées sont vertes, `1` sinon. Une porte qui n'avait rien à observer dans cette
configuration est dite **SANS OBJET** : elle ne compte ni pour ni contre, pour qu'un banc dégradé ne passe jamais pour un banc
complet. Tout est écrit dans `<dossier>/sortie/` : `bilan.json`, `banc.log`, les journaux de chaque porte, les relevés des
pilotes et de l'espion. Une étape que la tête éprouvée ne **livre** pas encore (mode complet) est dite **EN ATTENTE**, avec sa
raison, dans le journal et dans `bilan.json` (`enAttente`) : ni verte, ni rouge. Une porte dont tous les points observés sont
verts mais qui attend encore est « VERTE, PARTIELLE », jamais « VERTE » tout court.

### 2.1 Deux exécutions obligatoires

Un banc complet de la salle, ce sont **deux exécutions**, et aucune ne remplace l'autre :

1. le banc **hors ligne avec de vrais dépôts** (défaut, sans `--sans-git`) : `git`, G1, G2, G12, G9, `mes`, `hooks`, G14, SUL,
   `sup` — la salle réelle devant des pilotes ;
2. le banc **complet** (`--complet`) : le cockpit réel et ses portes (fumée, puis L27a et L27b), qui ne se jouent pas devant des
   pilotes.

Ce n'est plus la raison d'avant. Jusqu'à L16c, les deux exécutions étaient « vrais dépôts » puis « `--sans-git` » : avec un dépôt,
la salle ne démarrait pas sur un hôte Windows (`g1`, `g2`, `g12`, `g9`, `mes`, `g14` inatteignables), et sans dépôt la porte
`git` était « SANS OBJET » et M23 « non mesurable » (reste R-3 de la clôture 2 bis). Depuis les montages inversés de L16c
(§5.1), **une** exécution hors ligne avec de vrais dépôts mesure la porte `git` ET le reste : le train de V3 de la 2 ter l'a
rejoué ainsi (commit f321659), et L21b de même. `--sans-git` ne sert plus qu'au diagnostic.

### 2.2 Lancement détaché obligatoire

Lancé depuis un shell **d'arrière-plan** (celui d'un harnais d'agents, d'un éditeur…), `run-banc.mjs` est tué peu après la
première passe de G1 : journal figé, pile debout, verrou gardé (reste R-9 de la clôture 2 bis, mesuré). Toute exécution longue
se lance donc en processus **détaché**, sortie redirigée vers un fichier, puis on sonde ce fichier et `bilan.json` :

```powershell
$depot = 'C:\chemin\du\depot'
$journaux = "$env:TEMP\sal11-omo-banc-journaux"; New-Item -ItemType Directory -Force $journaux | Out-Null
Start-Process -FilePath node -WorkingDirectory $depot -WindowStyle Hidden `
  -ArgumentList @('e2e/omo-banc/run-banc.mjs', '--id', 'l21', '--duree-g1-min', '30') `
  -RedirectStandardOutput "$journaux\banc.log" -RedirectStandardError "$journaux\banc.err"
Get-Content "$journaux\banc.log" -Tail 20   # à répéter jusqu'à la ligne « bilan : … »
```

Si un banc a quand même été tué : `docker compose ls` montre le projet `sal11-omo-banc-<id>` resté debout ; le retirer avec
les mêmes fichiers compose, le même `--env-file` (gardé dans le dossier du banc tant que le banc n'a pas fini) et `--profile omo`,
puis supprimer le verrou `%TEMP%\sal11-omo-banc.lock` si son PID est mort (le banc suivant le reprend de lui-même).

### 2.3 Banc complet : le cockpit réel

`cockpit/preparer.mjs` extrait `--ref` par `git archive` hors du dépôt (fichiers SUIVIS seulement, à un commit précis),
bascule l'unique `export const SALLE_OUVERTE = false;` de `app/server/wiring-11.ts` **dans la copie** (zéro ou deux
occurrences : arrêt), et bâtit l'image. Le dépôt n'est jamais touché, et **aucune variable d'environnement n'ouvre la salle**.
`cockpit/cockpit.compose.yml` remplace alors les pilotes :

| Service | Rôle |
|---|---|
| `cockpit` | le cockpit réel jetable ; `COCKPIT_OMO=on`, il joint la salle **à travers l'espion** ; HTTP explicite sur la boucle locale (`COCKPIT_PORT` du banc, jamais 7777) |
| `opencode`, `cockpit-prepare`, `faux-fournisseur` | l'instance principale réelle devant le faux fournisseur du banc e2e (modèle L7a), avec un `auth.json` factice que le cockpit publie, réduit, vers la salle |
| `opencode-omo`, `egress`, `banc-copilot`, `banc-espion` | comme hors ligne |
| `banc-amorce`, `banc-battement` | démarrés sur `--battement-banc` seulement |

Hors ligne **par le réseau** : le réseau `default` du projet est `internal: true` ; les ports publiés passent par `banc-front`,
un pont sans traduction d'adresse (l'hôte joint le service, le service ne joint rien). `/certs` et `/archives` du produit sont
remplacés par des dossiers du banc.

**Battement : constat remis à l'intégrateur.** Aucun code de production n'appelle `omoControl.startHeartbeat()` — ni sur la tête
de la vague 3, ni dans les branches de la vague 4 commitées au 24/09 (L22c, L22d, L23b, L23c, L25b). Un cockpit réel publie
donc l'authentification et fait le pré-contrôle, mais n'écrit aucun battement et ne dépose pas la liste des projets dans le
volume de contrôle : la salle ne démarre jamais (homme mort). `--battement-banc` fait faire ces deux gestes aux pilotes du banc,
pour éprouver tout le reste, et la fumée le dit « EN ATTENTE ». Le jour où le produit bat lui-même, `--a-blanc --complet` le
voit (« battement déclenché par le cockpit oui ») et l'option n'est plus nécessaire.

La **fumée** (`cockpit/fumee.mjs`) suit le chemin de la page : mode Avancé ; `SALLE_OUVERTE` portée par l'image ; authentification
publiée (entrée `github-copilot` seule, `0600`, relevée sans jamais lire la valeur) ; salle « prête » ; pré-contrôle réel (le
`precheck-ok` porte le `startId` publié par le superviseur et il est inscrit dans `omo_room_starts`) ; ouverture d'une salle,
racine créée sur la salle à travers l'espion ; activation à 0,10 $ ; un appel d'outil ; fin de demande → relance à neuf ; zéro
`POST …/command`. Ce que la tête ne livre pas (activation L22c, fin de demande L22d et L23b) est « en attente », et une
activation refusée doit alors n'avoir **rien** envoyé, ce qui est vérifié.

`lib/lib-activation.mjs` (ouvrir, activer avec un montant en chaîne, envoyer — jamais d'envoi sans activation acceptée) et
`lib/lib-arret.mjs` (arrêter, attendre le repos ou une relance à neuf, écart d'activité, empreintes) sont les bibliothèques
**communes** à L27a et L27b ; `lib/scenarios-faux.mjs` fabrique les réponses scriptées du faux fournisseur (`read`, `grep`,
`glob`, `list`, `bash`, `task`, `call_omo_agent`, `skill_mcp`, `skill`, séries de 429, 30 sessions, réponses lentes). Une porte
posée dans `portes/*.mjs` (export par défaut `{ id, titre, executer }`) est chargée d'elle-même en mode complet.

### 2.4 M28 : les automatismes gardés (`hooks`)

Le scénario `hooks` (hors ligne) provoque trois automatismes gardés — `todo-continuation-enforcer` (liste de tâches laissée
ouverte, agent `build`), `prometheus-md-only` (le planificateur écrit un fichier qui n'est pas un plan) et `atlas`
(l'orchestrateur écrit au lieu de confier) — avec les agents résolus par leur clé dans `GET /agent`. Un répondeur **du banc**
accorde « une fois » la seule écriture d'un fichier du projet jetable ouvert et refuse tout le reste. Il relève les **types**
de directives marquées `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - <TYPE>]` (même motif que la détection 2 du cockpit), jamais un texte,
sur quatre canaux : le flux d'événements, les conversations stockées (outils comptés par « nom:état »), le journal du conteneur
et le journal de l'extension (`/tmp/oh-my-opencode.log` dans la salle : comptes de lignes et phrases fixes du code par
automatisme, aucune donnée de session). Le tout va dans `hooks-m28.json`. Ce relevé est **remis** à l'intégrateur :
`docs/omo-audit-4.19.4.md` (L20) n'est pas modifié par le banc.

Relevé du 24/09 (L21b, image `sal11-omo/opencode-omo:sal11`) : les trois automatismes **se déclenchent** (lignes à leur nom
dans le journal de l'extension), mais **aucune** directive marquée n'atteint le flux, les conversations stockées ni les
journaux. Le détail, et ce qu'il implique pour la détection 2 et pour la table d'audit, est dans `execution/mesures/L21b.md`.

### 2.5 Lien M22

Après G1 (la seule porte qui relève M22, sous charge), le banc relit `MEM_MAX_MIO`, `PIDS_MAX` et `M22_MEM_RELEVE_MAX_PUBLIE`
dans `app/server/omo-compose.test.ts` et juge son propre relevé contre elles (porte `lien-m22` du bilan, reste R-2) : un relevé
plus haut que la constante rend le lien **rouge**, avec la ligne à corriger ; des constantes introuvables aussi. Les constantes
ne peuvent donc plus dériver en silence derrière un banc ; `g1-stats.json` garde le relevé brut.

---

## 3. Garde-fous

Ils passent **avant** la moindre commande Docker, et le nettoyage les repasse :

1. **Nom de projet.** Il doit commencer par `sal11-omo-banc-`. `opencode-cockpit`, `ocauto-*`, `cockpit-e2e*` et les préfixes
   des autres travaux (`omo11-`, `it11-`, `eq11-`, `c511-`, `3d11-`, `gf0-`…) sont refusés, deux fois : par le préfixe imposé
   et par une liste noire. `nettoyerProjet` et `restes` revérifient le nom avant d'agir : même appelées depuis un gestionnaire
   d'erreur, elles ne peuvent pas effacer la pile de l'utilisateur.
2. **Verrou.** Un seul banc à la fois (`%TEMP%\sal11-omo-banc.lock`, PID et projet). Un verrou dont le processus est mort est
   repris ; un verrou vivant fait refuser, en nommant le PID.
3. **Ports.** Deux publications, sur la boucle locale seulement, par des variables `BANC_PORT_*` : jamais 7777.
4. **Mot de passe et jeton de pilotage.** Tirés au hasard à chaque exécution (`crypto.randomBytes`), écrits dans un fichier
   d'environnement en `0600`, supprimé à la fin. Jamais affichés, jamais journalisés.
5. **`MSYS_NO_PATHCONV=1`** devant toute commande : sans elle, Git Bash réécrit `/control` en chemin Windows.
6. **Nettoyage même en échec**, limité au projet du banc, suivi du relevé des restes et de la comparaison de la pile de
   l'utilisateur avant et après.

`app/server/omo-banc.test.ts` tient chacun de ces points, sans Docker : retirer une garde fait tomber ce test.

---

## 4. Ce que monte le banc

| Service | Rôle |
|---|---|
| `omo-init`, `egress`, `opencode-omo` | **du produit**, sans la moindre modification |
| `banc-copilot` | faux fournisseur scripté (L21a) en **TLS sur 443**, alias réseau et adresse fixe des trois noms d'API Copilot, autorité de banc dans `/certs` (MO-9) |
| `banc-amorce` | dépose `omo-projets.json` dans le volume de contrôle, puis sort (ce que ferait le cockpit) |
| `banc-auth` | dépose l'`auth.json` **factice** : entrée `github-copilot` seule, `expires` lointain, `0600` |
| `banc-battement` | réécrit `heartbeat` toutes les 5 s, et note chaque écriture — l'arrêter, c'est la porte G9 |
| `banc-precheck` | écrit un `precheck-ok` pour **chaque** `startId` : c'est ce qui rend une relance à neuf observable |
| `banc-espion` | seul chemin de l'hôte vers la salle ; relaie sans rien transformer et note méthode, chemin, code, durée, octets et débit d'événements (M20, M21, R16) |

`opencode-omo` n'a **qu'un** réseau, et il est `internal: true`. Les certificats sont fabriqués dans un conteneur jetable sans
réseau, valables **2 jours** ; la clé privée du faux ne quitte jamais `certs-prive/`, que la salle ne monte pas. La
vérification TLS n'est jamais coupée : c'est l'autorité de banc, désignée par `NODE_EXTRA_CA_CERTS`, qui la fait passer.

---

## 5. Défauts reproduits par le banc (à corriger dans le produit)

### 5.1 Sur un hôte Windows, un `.git` monté `:ro` n'était pas protégé — **corrigé dans le produit (L16c, montages inversés)**

> **Depuis L16c (décision A16, option E1), le dossier de travail ENTIER est monté en lecture seule sur `/workspace`**, et
> `install.ps1` ne rouvre l'écriture que par exception : un montage par entrée de premier niveau de chaque projet préparé,
> jamais `.git` ni un nom qui s'y ramène, jamais la racine d'un projet. Tout alias est alors résolu sous un ancêtre en lecture
> seule et répond `EROFS`. **L'image doit être reconstruite** : la sonde du superviseur a changé (`supervisor-lib.mjs` est
> dans le périmètre du manifeste).

Ce que le banc avait mesuré, et qui reste la raison d'être de cette topologie. Le partage de Docker Desktop (9p/drvfs) est
**insensible à la casse**. Un montage `:ro` protège **un chemin**, pas un dossier : `/workspace/p/.git` était bien en lecture
seule (`EROFS`), mais `.GIT`, `.Git`, le nom court `GIT~1` (alias de la feuille) et `/workspace/P/.git` (alias du dossier
parent) désignaient le même dossier **sans traverser le montage** — crochet `hooks/pre-commit` compris. La sonde du
superviseur voyait ce doute et fermait la salle : sur un poste Windows, la salle ne démarrait jamais dès qu'un projet portait
un dépôt.

La porte `git` mesure désormais la topologie E1, depuis la salle en tant que `node`, puis **côté poste** : `/workspace` en
`ro` dans `mountinfo` et l'écriture rouverte sur les seules entrées attendues ; zéro alias inscriptible par la feuille ET par
le parent, zéro crochet posable ; écriture LÉGITIME (fichier neuf, dossier profond, fichier écrit en place) persistée sur le
poste ; refus `EROFS` à la racine d'un projet et du dossier de travail, sous un alias d'entrée ouverte et par remontée `..` ;
liens durs refusés par `EXDEV`, même entre deux entrées ouvertes ; dépôts intacts (empreinte de chaque fichier de `.git`
avant et après) ; aucun `.omo` créé ; et la salle **démarre**. Elle retire ensuite ce qu'elle a écrit légitimement et
rétablit le fichier écrit en place, à l'octet. Rejouée au train de V3 de la 2 ter : verte trois fois sur ce PC.

Conséquence pour le banc : un banc complet se joue avec de vrais dépôts. `--sans-git` reste disponible (porte `git` sans
objet, M23 non mesurable), mais n'est plus le seul moyen de mesurer le reste sur un hôte Windows.

Friction dite à l'utilisateur (A16 point 6) : l'IA de la salle ne peut créer ni fichier ni dossier à la racine d'un projet
(refus net), et `install.ps1` est à relancer après un ajout à cette racine.

### 5.2 `CLAUDE_CONFIG_DIR` : la salle mourait au premier envoi — **corrigé dans le produit**

> **Depuis le train de V3, le produit pose lui-même `CLAUDE_CONFIG_DIR=/home/node/.local/state/claude`**, par `ENV` dans
> `docker/opencode-omo/Dockerfile`. Le croisement `croisements-2bis-v3.test.ts` tombe si la variable disparaît ou si sa valeur
> retombe sous l'un des cinq dossiers montés `:ro`. **L'image doit être reconstruite** (`build-omo-image.ps1`) pour que le
> correctif entre en vigueur : une archive plus ancienne porte encore le défaut. `--contournement` ne sert plus qu'à prouver la
> non-régression (il pose la MÊME valeur) ; **G2 se joue toujours sans lui**.

Ce que le banc avait mesuré, et qui reste la raison d'être de la variable : au **premier démarrage réel**, la salle démarrait,
servait `GET /config` et `GET /agent`… et mourait au premier envoi :

```
ERROR message="prompt_async failed"
      cause="Die(Error: EROFS: read-only file system, mkdir '/home/node/.claude/transcripts')"
```

L'extension calcule ce chemin par `getClaudeConfigDir()` : la variable `CLAUDE_CONFIG_DIR` si elle est posée, sinon
`homedir()/.claude` — l'un des cinq dossiers montés en lecture seule (D-2b-33). Elle y écrit `transcripts` et `todos`, **même
avec `claude_code.hooks: false`**.

Ce défaut **ne se contourne pas depuis le compose** : un tmpfs sur `/home/node/.claude/transcripts` fait échouer la création du
conteneur (on ne monte rien sous un montage en lecture seule), et rendre `/home/node/.claude` inscriptible ferait refuser le
démarrage à l'étape 3 du superviseur. Le seul levier est `CLAUDE_CONFIG_DIR`, qui appartient au produit — c'est la voie
retenue : `ENV` de l'image, donc sans dépendre d'aucune variable d'hôte.

`banc-contournement.compose.yml` (option `--contournement`) posait cette variable pour le banc **seulement**, afin que les
mesures puissent se faire malgré le défaut. Il est gardé comme preuve de non-régression, avec la même valeur que le produit.

---

## 6. Ce que le banc ne fait pas

- **Aucun appel facturé**, aucun jeton réel, aucune recette Copilot : la partie « puis recette » de G1, et G3, G4, G5, G10, G11
  restent en attente (plan §3.3).
- Il ne bascule **jamais** `SALLE_OUVERTE` dans le dépôt, et jamais par une variable d'environnement : hors ligne, le cockpit
  n'est pas lancé ; en mode complet, la bascule vit dans la copie `git archive` jetable, hors du dépôt, et nulle part ailleurs.
- Il ne touche ni `docker-compose.yml`, ni `install.ps1`, ni le superviseur, ni le Dockerfile de la salle, ni `guard/`, ni
  `lib/faux-copilot.mjs`, ni `e2e/lib/faux-fournisseur.mjs` (réemployé tel quel en mode complet).
- Il ne modifie pas `docs/omo-audit-4.19.4.md` : le relevé M28 (`hooks-m28.json`) est remis à l'intégrateur.
- Il ne supprime que ses propres ressources : le projet `sal11-omo-banc-<id>` (conteneurs, volumes, réseaux). Les images
  étiquetées `:sal11` et le registre jetable `sal11-omo-banc-registry` (s'il a été lancé à la main pour `--image-base`) sont
  gardés pour les bancs suivants.
- Il ne lit aucun `.env` du dépôt et n'écrit aucun secret : le seul fichier d'environnement est le sien, hors du dépôt, en
  `0600`, supprimé à la fin.
