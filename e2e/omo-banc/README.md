# Banc hors ligne de la Salle Oh My OpenAgent

Ce banc monte **la vraie salle** — l'image `opencode-omo` (opencode 1.18.30 + Oh My OpenAgent 4.19.4), le compose du produit,
le superviseur, le proxy de sortie — sur un réseau **fermé**, devant un **faux** GitHub Copilot, et joue les portes G1, G2,
G9 (pilote), G12, G14 et SUL, puis les mesures du plan.

Il ne coûte rien et ne sort nulle part : l'`auth.json` posé est factice, son `expires` est lointain (aucun aller-retour vers
`api.github.com`), et le seul hôte que le proxy de sortie accepte est détourné vers le faux fournisseur.

Le **cockpit n'est pas lancé ici** : trois pilotes tiennent sa place pour le battement, l'authentification et le pré-contrôle.
Le banc avec le cockpit réel, c'est L21b.

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

# le cas réel : projets avec de vrais dépôts git — sur un hôte Windows, la salle REFUSE de démarrer (§5)
node e2e/omo-banc/run-banc.mjs --id defaut --scenarios git,g2 --duree-g1-min 1

# banc complet, dégradé pour que tout le reste soit mesurable sur ce PC
node e2e/omo-banc/run-banc.mjs --id l21 --sans-git --contournement --duree-g1-min 30 \
  --image-base 127.0.0.1:5111/<dépôt>/opencode@sha256:<64 hex>

# une porte seule, en abrégeant G1
node e2e/omo-banc/run-banc.mjs --id l21 --scenarios g2,g9 --duree-g1-min 1
```

| Option | Rôle |
|---|---|
| `--a-blanc` | n'appelle jamais Docker : affiche les commandes, vérifie les refus et la présence des fichiers |
| `--id <id>` | identifiant du banc ; le projet Compose vaut `sal11-omo-banc-<id>` |
| `--scenarios` | `git,g1,g2,g12,g9,mes,g14,sul` (défaut : tous, dans cet ordre) |
| `--duree-g1-min` | durée des scénarios scriptés de G1 (défaut : 30 minutes, comme la porte le demande) |
| `--image`, `--image-app`, `--image-base` | images employées ; `--image-base` déclenche l'auto-test `-SelfTest` de G14 |
| `--contournement` | ajoute `banc-contournement.compose.yml` — **défaut du produit reproduit**, voir §5 |
| `--sans-git` | projets préparés **sans dépôt** : banc DÉGRADÉ, seul moyen de mesurer le reste sur un hôte Windows (§5) |
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
pilotes et de l'espion.

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

### 5.1 Sur un hôte Windows, un `.git` monté `:ro` n'est pas protégé — et la salle ne démarre plus

C'est le défaut le plus grave que ce banc ait trouvé, et il en cache un second.

Le partage de Docker Desktop (9p/drvfs) est **insensible à la casse**. Le montage `:ro` protège **un chemin**, pas un dossier :
`/workspace/p/.git` est bien en lecture seule (`EROFS`), mais `/workspace/p/.GIT`, `/workspace/p/.Git` et le nom court
`GIT~1` désignent le même dossier **sans traverser le montage**. Mesuré sur ce PC : écriture acceptée par tous les alias, y
compris `hooks/pre-commit` — un crochet posé depuis la salle s'exécuterait sur le poste au prochain `git commit`.

La sonde `aliasInscriptible` du superviseur (relecture 2bis-vague-2, risque 11 / C2-5) **voit** ce doute et ferme la salle,
comme elle le doit. Conséquence directe : sur un poste Windows, dès qu'un projet préparé porte un dépôt — c'est-à-dire
toujours — le superviseur s'arrête à `ATTENTION: dossier de travail non protege` et **n'ouvre jamais opencode**.

La porte `git` mesure les deux faits : les alias inscriptibles (rouge, c'est le défaut) et la fermeture de la salle (vert,
c'est le comportement attendu). `--sans-git` retire les dépôts pour que tout le reste soit mesurable ; M23 est alors déclarée
non mesurable au lieu d'être déclarée fausse.

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
- Il ne bascule **jamais** `SALLE_OUVERTE` : la salle reste coupée côté cockpit, et le cockpit n'est pas lancé.
- Il ne touche ni `docker-compose.yml`, ni `install.ps1`, ni le superviseur, ni le Dockerfile de la salle, ni `guard/`, ni
  `lib/faux-copilot.mjs`.
- Il ne lit aucun `.env` du dépôt et n'écrit aucun secret : le seul fichier d'environnement est le sien, hors du dépôt, en
  `0600`, supprimé à la fin.
