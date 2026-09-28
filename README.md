# opencode cockpit

Poste de pilotage web pour [opencode](https://opencode.ai) 1.18.30, conçu pour travailler avec GitHub Copilot en entreprise. Tout tourne sur votre poste, dans Docker Desktop. Pour les IA, seul GitHub Copilot est contacté. L'interface s'ouvre en mode Simple, pensé pour des collègues peu familiers de l'IA. Le mode Avancé se choisit dans **Paramètres › Affichage**.

**Ce que vous y faites**

- Confier une tâche à un **assistant** : une tâche, des droits limités, une IA fixée. Dix exemples « Prêts à l'emploi », ou une création guidée en cinq écrans.
- Choisir un **niveau d'IA** : Rapide, Équilibré ou Expert. L'IA qui va répondre et le coût estimé s'affichent avant l'envoi.
- Suivre la réponse en direct : outils lisibles (commandes, modifications, travail délégué), autorisations en un clic, `@fichier`, `/raccourci`, images.
- Voir qui travaille, tout arrêter d'un geste, et choisir l'autonomie de l'IA, avec des plafonds.
- Relire les fichiers de vos projets sans rien modifier, dans l'onglet **Fichiers**.
- Retrouver chaque conversation résumée, classée et copiée en Markdown, dans la page **Archives**.
- Suivre la dépense du mois face au budget, 150 $ par défaut, dans la page **Coûts**. Ce budget est suivi par le cockpit : il ne bloque rien chez GitHub.
- En mode Avancé, régler agents, skills, commandes et consignes (`AGENTS.md`) dans le **Studio**. Chaque enregistrement est vérifié par opencode ; un enregistrement refusé est annulé automatiquement.

**Ce document et les autres**

- Ce README : prérequis, installation, mise à jour, premiers pas, pannes les plus courantes.
- [docs/GUIDE.md](docs/GUIDE.md) : tout le reste, rangé en quatre familles. Chaque élément porte un identifiant stable : P pour une procédure, R pour une fiche de réglages ou de référence, X pour une panne, E pour une explication facultative. Dans ce README, un identifiant comme [P-27](docs/GUIDE.md#p-27-arrêter-une-demande) est un lien vers le guide.
- [docs/RECAPITULATIF.md](docs/RECAPITULATIF.md) : fonctionnement, sécurité en détail, validations et limites.
- [docs/NOTES-1.1.0.md](docs/NOTES-1.1.0.md) : notes de la version 1.1.0 et retour arrière.
- [docs/DEVELOPPEMENT.md](docs/DEVELOPPEMENT.md) : développer, tester et publier.

**À savoir avant de commencer**

- Au travail, une installation peut s'arrêter sur un réglage du réseau : stratégie d'Edge, certificat, adresse Copilot. C'est prévu. Le script vérifie le plus souvent avant de modifier, et ses messages d'arrêt donnent en général la commande suivante. Relancer `.\install.ps1` garde les secrets et les réglages déjà écrits.
- **Deux commandes effacent des données sans retour possible.** Chacune demande de taper un mot de confirmation :
  - `.\cockpit.ps1 restore <fichier>` remplace les conversations, les assistants, les réglages, les coûts, les archives indexées et la configuration d'opencode par ceux de la sauvegarde : tout ce qui a été fait depuis cette sauvegarde est perdu ;
  - `.\cockpit.ps1 uninstall -Purge` efface les conversations, les assistants, les réglages, les coûts, l'index des archives, la connexion GitHub Copilot, le certificat local et les images du cockpit. Restent : les copies Markdown de `archives\`, les sauvegardes de `backups\`, `certs\` et `.env`.
- Le guide liste ses procédures irréversibles dans sa partie [Lire ce guide](docs/GUIDE.md#lire-ce-guide).

**Par où commencer.** Première installation : [Prérequis](#prérequis), [Installation](#installation), puis [Premiers pas en mode Simple](#premiers-pas-en-mode-simple). Cockpit déjà installé en 1.0.5 ou plus récent : [Mettre à jour](#mettre-à-jour). Quelque chose bloque : [Pannes les plus courantes](#pannes-les-plus-courantes).

## Sommaire

1. [Nouveautés de la 1.1.0](#nouveautés-de-la-110)
2. [Prérequis](#prérequis)
3. [Installation](#installation)
4. [Mettre à jour](#mettre-à-jour)
5. [Premiers pas en mode Simple](#premiers-pas-en-mode-simple)
6. [Ce qui sort sur le réseau](#ce-qui-sort-sur-le-réseau)
7. [Commandes du quotidien](#commandes-du-quotidien)
8. [Pannes les plus courantes](#pannes-les-plus-courantes)
9. [Où trouver le reste](#où-trouver-le-reste)
10. [Licence](#licence)

## Nouveautés de la 1.1.0

Voici ce que la 1.1.0 apporte. Le détail est dans [docs/NOTES-1.1.0.md](docs/NOTES-1.1.0.md).

- **Voir qui travaille.** « Qui travaille ? », le Déroulé et la carte du travail en direct montrent chaque assistant au travail pour votre demande. [Arrêter] arrête toute la conversation, travail délégué compris ([R-18](docs/GUIDE.md#r-18-qui-travaille), [P-27](docs/GUIDE.md#p-27-arrêter-une-demande)).
- **Plan d'abord.** L'IA écrit un plan dans une conversation qui ne peut rien modifier ([P-28](docs/GUIDE.md#p-28-faire-écrire-un-plan-puis-lexécuter)).
- **Autonomie à la demande.** Quatre choix par conversation, des plafonds qui arrêtent le travail, et un Journal du contrôle ([R-22](docs/GUIDE.md#r-22-les-quatre-choix-dautonomie), [P-32](docs/GUIDE.md#p-32-laisser-lia-modifier-les-fichiers-sans-demander), [P-33](docs/GUIDE.md#p-33-lancer-une-demande-en-autonome-avec-contrôle)).
- **IA de contrôle active par défaut.** En « Autonome avec contrôle », elle juge les commandes que le cockpit ne connaît pas. Elle n'a pas encore été essayée sur les 60 programmes inconnus prévus avant publication : la qualité de ses décisions n'est pas mesurée. Elle se coupe dans **Paramètres › Budget** ([R-26](docs/GUIDE.md#r-26-onglet-budget-des-paramètres)).
- **Salle de contrôle et « Revoir ».** Une vue d'ensemble du travail en cours, en 3D si le poste la dessine bien, en 2D sinon. Et le rejeu d'une demande passée, sans rien relancer ni facturer ([P-39](docs/GUIDE.md#p-39-ouvrir-la-salle-de-contrôle), [P-40](docs/GUIDE.md#p-40-revoir-une-demande-passée)).
- **Équipes et carte des assistants.** Plusieurs assistants sur une même demande, en mode Avancé. Les équipes restent fermées en mode Simple, le temps des essais d'accessibilité ([P-42](docs/GUIDE.md#p-42-installer-un-exemple-déquipe-puis-lancer-une-équipe), [R-41](docs/GUIDE.md#r-41-équipes-en-mode-simple)).
- **Méthodes et Seconde lecture**, dans les deux modes. Une méthode guide la réponse ; la Seconde lecture fait relire une réponse par un autre assistant ([P-48](docs/GUIDE.md#p-48-ajouter-une-méthode-à-un-message), [P-50](docs/GUIDE.md#p-50-demander-une-seconde-lecture)).
- **Onglet Fichiers.** Relire les fichiers de vos projets en lecture seule : rien n'est modifié, rien n'est envoyé à une IA ([P-38](docs/GUIDE.md#p-38-relire-un-fichier-que-lia-vient-décrire)).
- **L'assistant ne va plus sur Internet.** Les profils de droits refusent la consultation d'Internet, et la mise à jour ferme ces règles dans une installation existante ([P-36](docs/GUIDE.md#p-36-fermer-laccès-à-internet-dun-profil-ou-dun-assistant-signalé), [E-03](docs/GUIDE.md#e-03-pourquoi-internet-est-fermé-depuis-la-110)).
- **Liste des demandes d'autorisation reconstituée** quand opencode 1.18.30 ne sait plus afficher cette liste ([X-53](docs/GUIDE.md#x-53-liste-des-demandes-dautorisation-illisible), [E-26](docs/GUIDE.md#e-26-pourquoi-la-liste-des-demandes-dautorisation-est-reconstituée)).
- **Sauvegarde et restauration réparées.** En 1.0.6, elles échouaient sous Windows PowerShell 5.1. Faites une sauvegarde après la mise à jour ([P-16](docs/GUIDE.md#p-16-sauvegarder-le-cockpit)).
- **Rien d'autre ne change de nature.** Mode Simple par défaut, GitHub Copilot seul, et une seule dépendance ajoutée : la bibliothèque 3D (voir [Licence](#licence)).

Au premier affichage du chat ou de la page **Assistants**, une annonce résume ces nouveautés. Elle reste affichée jusqu'à un clic sur [Voir la carte] ou [Compris], puis ne revient plus. En mode Simple, elle ne propose aucune équipe.

Les nouveautés de la 1.1.0 qui appellent l'IA (travail délégué, autonomie et IA de contrôle, équipes, méthodes, Seconde lecture) n'ont pas encore été essayées sur GitHub Copilot réel : aucun essai facturé n'a été fait. La liste est dans le récapitulatif, section [Limites et points à vérifier](docs/RECAPITULATIF.md#11-limites-et-points-à-vérifier).

### Salle Oh My OpenAgent livrée coupée

Le code de la Salle Oh My OpenAgent est dans la version, mais la salle est **coupée par le code**. Aucune option de la 1.1.0 ne l'ouvre : ni le fichier `.env`, ni `install.ps1`.

- `.\install.ps1 -OmoArchive <archive>` peut charger son image sur le poste. La salle reste coupée ([P-20](docs/GUIDE.md#p-20-charger-limage-de-la-salle-omo-facultatif-la-salle-reste-coupée)).
- Sa mise en service passera par une version dédiée.
- Pourquoi elle est coupée : [E-17](docs/GUIDE.md#e-17-salle-oh-my-openagent-livrée-coupée). Ce qu'elle ne protège pas : [E-19](docs/GUIDE.md#e-19-ce-que-la-salle-omo-ne-protège-pas).

## Prérequis

| Élément | Ce qu'il faut |
|---|---|
| Docker Desktop | Démarré, avec Docker Compose 2.8 ou plus récent (inclus dans Docker Desktop). Son installation demande les droits administrateur, WSL 2 et la virtualisation activée. |
| Abonnement GitHub Copilot | Pro, Pro+, Business ou Enterprise. |
| Windows PowerShell | 5.1 ou plus récent, en mode de langage complet. Sinon, les scripts s'arrêtent sans rien modifier ([X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer)). |
| `curl.exe` de Windows | Version 7.60 ou plus récente, avec Schannel. Il sert à vérifier le cockpit. Sans lui, les scripts compilent une petite classe .NET, que l'antivirus peut signaler ([X-11](docs/GUIDE.md#x-11-voie-de-secours-par-une-classe-net)). |
| Git | Facultatif. Il sert à `.\cockpit.ps1 update`. Sans Git : [P-02](docs/GUIDE.md#p-02-installer-sans-git-depuis-larchive-zip) pour installer, [P-06](docs/GUIDE.md#p-06-mettre-à-jour-un-dossier-obtenu-par-zip) pour mettre à jour. |
| Dossier des projets | Le dossier **parent** de vos dépôts, par exemple `C:\dev`. Il doit être en dehors du dossier du cockpit ([R-03](docs/GUIDE.md#r-03-règles-du-dossier-des-projets)). |

**Poste d'entreprise : à vérifier avant d'installer**

- **Stratégie d'Edge.** Le cockpit est servi en `https://127.0.0.1:7777`, avec un certificat créé sur le poste. Le navigateur affiche donc un avertissement au premier accès. Si une stratégie d'entreprise interdit de le passer, il faut l'exception Edge `SSLErrorOverrideAllowedForOrigins = https://127.0.0.1:7777`, ou le mode HTTP local ([P-04](docs/GUIDE.md#p-04-passer-en-mode-http-local)). Pour le savoir d'avance, sans rien modifier : [P-01](docs/GUIDE.md#p-01-vérifier-un-poste-dentreprise-avant-dinstaller).
- **Proxy qui inspecte le HTTPS.** `install.ps1` exporte d'office les autorités de certification de Windows ([R-08](docs/GUIDE.md#r-08-proxy-et-certificats-dentreprise)).
- **Proxy de l'entreprise : nom complet ou adresse IP.** Donnez-le de préférence sous la forme `http://proxy.domaine.tld:8080`. Le cockpit ne transmet aucun nom sans point au DNS de l'entreprise : un nom court comme `http://proxy:8080` est remplacé par `install.ps1` par son nom complet, trouvé par le DNS de Windows, et écrit ainsi dans `.env`. S'il ne le trouve pas, `install.ps1` s'arrête avant toute modification et donne la commande à lancer ([X-22](docs/GUIDE.md#x-22-avertissement-ou-arrêt-sur-le-proxy-https-socks5-ou-nom-court)).
- **Pare-feu qui n'ouvre que l'adresse de votre abonnement Copilot** : [P-12](docs/GUIDE.md#p-12-imposer-ladresse-copilot-de-votre-abonnement).
- **Choix des IA.** L'organisation peut restreindre les IA Copilot ou l'usage de clients tiers. Quand la liste a pu être lue chez GitHub, une IA désactivée apparaît « Pas disponible », avec la raison, dans **Paramètres › Connexion**. Sinon : [X-70](docs/GUIDE.md#x-70-des-ia-désactivées-apparaissent-utilisables).
- **Licence de Docker Desktop.** Elle n'est gratuite que pour les structures de moins de 250 salariés **et** de moins de 10 M$ de chiffre d'affaires annuel. Au-delà, un abonnement Docker est nécessaire.

**Test rapide** : `docker run --rm hello-world` → Docker affiche son message de bienvenue, « Hello from Docker! ». S'il échoue au téléchargement : [X-03](docs/GUIDE.md#x-03-le-test-hello-world-échoue-au-téléchargement).

## Installation

**Avant de commencer**

- **Prérequis** : ceux de la partie [Prérequis](#prérequis). Docker Desktop est démarré. Sans Git, suivez [P-02](docs/GUIDE.md#p-02-installer-sans-git-depuis-larchive-zip) à la place de cette procédure.
- **À ouvrir** : une fenêtre Windows PowerShell. Menu Démarrer, taper `powershell`, puis la touche **Entrée**.
- **Durée** : 5 à 15 minutes de manipulation. En mode construction, les images demandent en plus quelques minutes la première fois.
- **Ce qui change** :
  - le dossier du cockpit reçoit un fichier `.env`, lisible par votre seul compte Windows (secrets et réglages), et `certs\windows-trust.pem` ;
  - Docker reçoit des images, des volumes et deux conteneurs ;
  - rien n'est installé dans Windows. Le certificat du cockpit n'est jamais ajouté au magasin de certificats de Windows.
- **Réversible** : en partie, par [P-19](docs/GUIDE.md#p-19-désinstaller-le-cockpit-irréversible-avec--purge). Avec `-Purge`, la désinstallation efface sans retour les volumes et les images. Le dossier du cockpit garde `.env`, `certs\`, `archives\` et `backups\`.
- **Interruption** : le script vérifie le plus souvent avant de modifier. S'il s'arrête, son message donne en général la commande suivante. Relancer `.\install.ps1` recommence depuis le début et garde les secrets et les réglages déjà écrits. Si la construction ou le téléchargement des images échoue, `.env` garde les images, le mode d'accès et le jeton précédents.

**Choisir la façon d'obtenir les images**

| Mode | Quand le choisir | Option à ajouter à l'étape 2 |
|---|---|---|
| Construction sur le poste (par défaut) | Docker Hub, le registre npm et les dépôts Debian sont joignables. | aucune |
| Téléchargement depuis GHCR | `ghcr.io` est joignable. | `-Mode Pull` |
| Archive hors ligne | Seul le navigateur atteint GitHub. Après l'étape 1, téléchargez l'archive, placez-la dans le dossier du cockpit et vérifiez-la par [P-03](docs/GUIDE.md#p-03-vérifier-et-charger-larchive-dimages-hors-ligne), jusqu'au résultat `True`. | `-Mode Load -ImagesArchive .\opencode-cockpit-images-1.1.0.tar.gz` |

Le mode choisi est mémorisé dans `.env` : les relances et les mises à jour le reprennent. Au travail, préférez l'archive hors ligne, qui ne télécharge rien ([R-10](docs/GUIDE.md#r-10-poste-de-travail-réglages-conseillés)).

**Étapes**

- [ ] **1.** Dans PowerShell, lancer `cd $env:USERPROFILE`, puis `git clone https://github.com/Calgar50/opencode-cockpit.git`, puis `cd opencode-cockpit`. Le dossier du cockpit doit rester **en dehors** du dossier des projets. → L'invite se termine par `\opencode-cockpit>`. Le dossier du cockpit est `opencode-cockpit`, dans votre dossier personnel de Windows.
- [ ] **2.** Lancer `.\install.ps1 -WorkspaceDir C:\dev`, en remplaçant `C:\dev` par le dossier parent de vos dépôts, et en ajoutant l'option du mode choisi. → Le script affiche « ==> Verification de Docker Desktop », puis ses étapes une à une. S'il demande « Le dossier '…' n'existe pas. Le creer ? (o/N) », taper `o`, puis la touche **Entrée**. Si Windows répond que l'exécution de scripts est désactivée sur ce système, lancer à la place `powershell -ExecutionPolicy Bypass -File .\install.ps1 -WorkspaceDir C:\dev` ([X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer)). Si le script s'arrête sur un de ses messages, ce message donne en général la commande à lancer : pannes [X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer) à [X-13](docs/GUIDE.md#x-13-le-cockpit-ne-répond-pas-après-240-secondes).
- [ ] **3.** Attendre la fin du script. → Il affiche « [OK] Cockpit disponible sur https://127.0.0.1:7777 (…) » et « Empreinte SHA-256 du certificat : … ». Le navigateur s'ouvre sur un avertissement de certificat : « Votre connexion n'est pas privée », dans Edge.
- [ ] **4.** Afficher le certificat que présente le navigateur, puis comparer son empreinte SHA-256 à celle écrite par le script. Le script l'écrit en majuscules, par paires séparées par des deux-points ; le navigateur peut l'écrire en minuscules, avec des espaces, ou d'un seul bloc. Seuls comptent les 64 lettres et chiffres, dans l'ordre. → Les deux suites de 64 caractères sont identiques. Si elles diffèrent, arrêtez-vous : [X-30](docs/GUIDE.md#x-30-avertissement-de-certificat-au-premier-accès).
- [ ] **5.** Cliquer [Avancé], puis le lien « Continuer vers 127.0.0.1 (non sécurisé) ». → Le cockpit s'ouvre, déjà connecté, sur la fenêtre « Avant de commencer ». Si le navigateur ne propose pas « Continuer » : [X-31](docs/GUIDE.md#x-31-page-127001-inaccessible-sans-bouton-continuer). Si la page affiche « Lien de connexion invalide, expiré ou déjà utilisé : relancez .\cockpit.ps1 open. », le lien a dépassé ses 10 minutes : lancer `.\cockpit.ps1 open` ([X-37](docs/GUIDE.md#x-37-lien-de-connexion-invalide-expiré-ou-déjà-utilisé)).

**À la fin**

- **État final** : le cockpit tourne. La fenêtre « Avant de commencer » attend votre accord. La suite est dans [Premiers pas en mode Simple](#premiers-pas-en-mode-simple).
- **Reprendre** : `.\cockpit.ps1 open` rouvre le cockpit à tout moment. Il vérifie le cockpit, puis ouvre un lien de connexion à usage unique, valable 10 minutes.

**Autres situations**

| Situation | Dans le guide |
|---|---|
| Vérifier le poste avant d'installer | [P-01](docs/GUIDE.md#p-01-vérifier-un-poste-dentreprise-avant-dinstaller) |
| Pas de Git : installer depuis l'archive ZIP | [P-02](docs/GUIDE.md#p-02-installer-sans-git-depuis-larchive-zip) |
| Archive d'images hors ligne | [P-03](docs/GUIDE.md#p-03-vérifier-et-charger-larchive-dimages-hors-ligne) |
| Edge interdit de passer l'avertissement de certificat | [X-05](docs/GUIDE.md#x-05-edge-interdit-de-passer-lavertissement-de-certificat), [X-31](docs/GUIDE.md#x-31-page-127001-inaccessible-sans-bouton-continuer), puis [P-04](docs/GUIDE.md#p-04-passer-en-mode-http-local) |
| Proxy ou certificats d'entreprise | [R-08](docs/GUIDE.md#r-08-proxy-et-certificats-dentreprise), [P-10](docs/GUIDE.md#p-10-ajouter-à-la-main-le-certificat-racine-du-proxy), [P-11](docs/GUIDE.md#p-11-changer-ou-retirer-le-proxy) |
| Pare-feu qui n'ouvre que l'adresse de l'abonnement Copilot | [P-12](docs/GUIDE.md#p-12-imposer-ladresse-copilot-de-votre-abonnement) |
| Changer le dossier des projets | [P-15](docs/GUIDE.md#p-15-changer-le-dossier-des-projets) |
| Ce que fait le script, dans l'ordre, et ses options | [R-02](docs/GUIDE.md#r-02-ce-que-fait-installps1-et-ses-options) |
| Règles du dossier des projets | [R-03](docs/GUIDE.md#r-03-règles-du-dossier-des-projets) |

Le certificat du cockpit est auto-signé, créé au premier démarrage. L'avertissement du navigateur revient au plus tard tous les 7 jours, et après chaque nouveau certificat. Utilisez toujours l'adresse `127.0.0.1` : `localhost` redemande l'avertissement ([R-06](docs/GUIDE.md#r-06-certificat-https-local)).

## Mettre à jour

Cette procédure vaut pour une installation 1.0.5 ou plus récente, dans un dossier obtenu par Git. Autres cas :

- dossier obtenu par ZIP : [P-06](docs/GUIDE.md#p-06-mettre-à-jour-un-dossier-obtenu-par-zip) ;
- version antérieure à la 1.0.5 : [P-07](docs/GUIDE.md#p-07-mettre-à-jour-depuis-une-version-antérieure-à-la-105) ;
- installation faite en 0.1.x : [P-07](docs/GUIDE.md#p-07-mettre-à-jour-depuis-une-version-antérieure-à-la-105), puis [P-08](docs/GUIDE.md#p-08-reprendre-les-réglages-après-une-mise-à-jour-depuis-la-01x).

**Avant de commencer**

- **Prérequis** :
  - les fichiers du cockpit suivis par Git ne sont pas modifiés à la main, et le dossier n'a aucun commit local ([X-19](docs/GUIDE.md#x-19-git-pull-a-échoué)) ;
  - en mode Load : l'archive d'images de la version visée (`opencode-cockpit-images-1.1.0.tar.gz` pour la 1.1.0) et son fichier `.sha256` sont dans le dossier du cockpit, vérifiés par [P-03](docs/GUIDE.md#p-03-vérifier-et-charger-larchive-dimages-hors-ligne) jusqu'au résultat `True`.
- **À ouvrir** : Windows PowerShell dans le dossier du cockpit, et le cockpit dans le navigateur.
- **Durée** : 5 à 10 minutes de manipulation. La construction ou le téléchargement des images s'ajoute.
- **Ce qui change** :
  - scripts et images passent à la nouvelle version ;
  - les conteneurs sont recréés : une réponse en cours serait coupée ;
  - en venant d'une 1.0.x, les règles Internet d'opencode sont fermées. Le profil de droits garde son nom. Quand le fichier de configuration d'opencode est modifié, une copie de l'ancien (`opencode.jsonc.avant-1.1.0`, le plus souvent) reste dans le volume de configuration d'opencode, et `.\cockpit.ps1 backup` la sauvegarde ;
  - le mode d'accès (HTTPS ou HTTP local) et le jeton ne changent pas : aucune reconnexion ;
  - le mot de passe interne d'opencode n'est renouvelé qu'en venant d'une version antérieure à la 1.0.6.
- **Réversible** : pas par `.\cockpit.ps1 rollback`, qui ne ramène jamais à la 1.0.6. Le retour de la 1.1.0 à la 1.0.6 est [P-09](docs/GUIDE.md#p-09-revenir-de-la-110-à-la-106).
- **Interruption** : relancer la même commande reprend la mise à jour. Les messages d'arrêt des scripts sont les pannes [X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer) à [X-27](docs/GUIDE.md#x-27-salle-omo-non-démarrée-par-cockpitps1).

**Étapes**

- [ ] **1.** Dans le cockpit, attendre la fin des réponses en cours, ou cliquer [Arrêter]. → Aucune conversation n'affiche plus le bouton [Arrêter].
- [ ] **2.** Lancer `.\cockpit.ps1 update`. → « ==> Recuperation de la derniere version (git pull) », puis les étapes d'`install.ps1`, jusqu'à « [OK] Cockpit disponible sur … ». En mode Load, le script s'arrête sur « [!] Mode Load : image … version … requise. », puis « Installation arretee avant toute modification (voir les messages ci-dessus). » : c'est attendu. Les scripts sont déjà à jour, et l'ancien cockpit tourne toujours : passez à l'étape 3. Un proxy donné par un nom court est remplacé par son nom complet (« [OK] Proxy donne par le nom court … ») ; si le DNS de Windows ne le trouve pas, le script s'arrête avant toute modification et l'ancien cockpit tourne toujours : lancez `.\install.ps1 -Proxy http://<nom.complet>:<port>` (en mode Load, avec les options de l'étape 3), sans `.\cockpit.ps1 start` ni `restart` avant ([X-22](docs/GUIDE.md#x-22-avertissement-ou-arrêt-sur-le-proxy-https-socks5-ou-nom-court)).
- [ ] **3.** En mode Load seulement : lancer `.\install.ps1 -Mode Load -ImagesArchive .\opencode-cockpit-images-1.1.0.tar.gz -NoBrowser`. → « [OK] Cockpit disponible sur … ».
- [ ] **4.** Chercher plus haut dans la fenêtre la ligne « ==> Passage a la 1.1.0 : l'assistant ne va plus sur Internet ». → Quatre cas :
  - la ligne est absente : vos règles étaient déjà fermées, rien à faire ;
  - la ligne suivante commence par « [OK] Profil de droits » ou par « [OK] Vos regles personnalisees sont conservees » : c'est fait ;
  - « [!] Certaines regles demandent encore l'acces a Internet : voir Parametres > Securite. » s'affiche : l'étape 6 y mène ([P-36](docs/GUIDE.md#p-36-fermer-laccès-à-internet-dun-profil-ou-dun-assistant-signalé)) ;
  - « [!] Regles Internet laissees telles quelles (…) » s'affiche : [X-14](docs/GUIDE.md#x-14-règles-internet-laissées-telles-quelles).
- [ ] **5.** Lancer `.\cockpit.ps1 open`. La mise à jour n'ouvre pas le navigateur. → Le cockpit s'ouvre, connecté. Au passage à la 1.1.0, il affiche une fois l'annonce de la nouvelle version, avec [Voir la carte] et [Compris].
- [ ] **6.** Ouvrir la page **Diagnostic**, carte « Réseau et sécurité ». → La ligne « Accès à Internet de l'assistant : fermé. » s'affiche. Si elle renvoie à **Paramètres › Sécurité** : [P-36](docs/GUIDE.md#p-36-fermer-laccès-à-internet-dun-profil-ou-dun-assistant-signalé).
- [ ] **7.** Lancer `.\cockpit.ps1 backup`. Les conteneurs sont arrêtés quelques instants pendant la copie. → « Sauvegarde terminee. Exclus volontairement : … », et un nouveau fichier `backups\cockpit-AAAAMMJJ-HHMMSS.tar.gz`.

**À la fin**

- **État final** : la nouvelle version tourne, les règles Internet sont fermées, et une sauvegarde neuve existe.
- **Reprendre** : si une étape a échoué, relancez la même commande.

**Cas particuliers**

- La fermeture d'Internet est rejouée à chaque `install.ps1` et à chaque `.\cockpit.ps1 restore` : une valeur « ask » remise à la main pour Internet repasse à « deny » ([E-03](docs/GUIDE.md#e-03-pourquoi-internet-est-fermé-depuis-la-110)).
- Les assistants créés dans le cockpit ne sont pas modifiés. Ceux qui avaient « Consulter Internet » sont signalés dans **Paramètres › Sécurité** ([P-36](docs/GUIDE.md#p-36-fermer-laccès-à-internet-dun-profil-ou-dun-assistant-signalé)).
- Avec `.\install.ps1 -NoStart`, les règles ne sont mises à jour que si opencode est arrêté ([X-15](docs/GUIDE.md#x-15-règles-internet-non-mises-à-jour-opencode-en-marche)).

## Premiers pas en mode Simple

**Avant de commencer**

- **Prérequis** : le cockpit est installé et ouvert ; vous avez un compte GitHub avec un abonnement Copilot.
- **Durée** : 10 à 20 minutes.
- **Ce qui change** : chaque message envoyé part chez GitHub Copilot et il est facturé. Rien n'est modifié dans vos fichiers tant que vous ne cliquez pas [Autoriser une fois].
- **Réversible** : la connexion à GitHub Copilot se retire par [P-22](docs/GUIDE.md#p-22-reconnecter-ou-déconnecter-github-copilot). Un message envoyé ne se reprend pas.
- **Interruption** : le code de connexion de GitHub expire au bout d'environ 15 minutes. Recommencer l'étape 2 en donne un nouveau.

**Étapes**

- [ ] **1.** Lire les six règles de la fenêtre « Avant de commencer », cocher « J'ai lu ces règles et je les appliquerai. », puis cliquer [Commencer]. → Le chat s'affiche. Sous la zone de saisie, le bandeau dit « Avant d'envoyer : aucune donnée client, aucun mot de passe, aucune clé. Relisez toujours la réponse : l'IA peut se tromper. ». L'annonce de la 1.1.0 s'affiche aussi ; [Compris] la ferme.
- [ ] **2.** Ouvrir **Paramètres › Connexion**, puis cliquer [Connecter] dans la carte « GitHub Copilot ». Pour GitHub Enterprise avec résidence des données, suivez plutôt [P-21](docs/GUIDE.md#p-21-connecter-github-copilot). → Un code d'appareil s'affiche, avec les boutons [Copier le code] et [Ouvrir GitHub].
- [ ] **3.** Cliquer [Copier le code], puis [Ouvrir GitHub]. Sur la page GitHub, coller le code et autoriser l'accès. → De retour dans le cockpit, la carte affiche « Connecté », et la carte « IA de votre compte GitHub Copilot » liste vos IA.
- [ ] **4.** Ouvrir la page **Assistants**, section « Prêts à l'emploi ». Cliquer [Installer] sur l'assistant qui correspond à votre tâche, puis [Installer] dans la fenêtre qui s'ouvre. → La fenêtre affiche « Assistant installé. Il apparaît maintenant dans le chat. », avec le bouton [Essayer].
- [ ] **5.** Cliquer [Essayer], vérifier le projet dans la liste en haut de la colonne des conversations, écrire la demande, lire près de [Envoyer] l'IA qui répondra et le coût estimé, puis cliquer [Envoyer]. → La réponse s'écrit en direct ; son coût s'affiche à son pied, avec le nombre d'appels d'IA.
- [ ] **6.** Quand une carte demande votre accord, lire l'action, puis cliquer [Autoriser une fois], ou [Refuser…] puis [Refuser]. → La carte se ferme, et l'assistant continue avec votre réponse ([P-26](docs/GUIDE.md#p-26-répondre-à-une-demande-dautorisation)).
- [ ] **7.** Pour tout arrêter à n'importe quel moment, cliquer [Arrêter]. → Le bouton [Arrêter] disparaît et [Envoyer] revient. Les demandes d'autorisation en attente sont refusées ([P-27](docs/GUIDE.md#p-27-arrêter-une-demande)).

**À la fin**

- **État final** : GitHub Copilot est connecté, un assistant est installé, et une première réponse est relue.
- **Reprendre** : page **Chat**, bouton [Nouvelle conversation].

**Pour la suite** : autonomie ([P-32](docs/GUIDE.md#p-32-laisser-lia-modifier-les-fichiers-sans-demander), [P-33](docs/GUIDE.md#p-33-lancer-une-demande-en-autonome-avec-contrôle)), onglet **Fichiers** ([P-38](docs/GUIDE.md#p-38-relire-un-fichier-que-lia-vient-décrire)), coûts ([R-46](docs/GUIDE.md#r-46-page-coûts-et-export-csv)), mode Avancé ([P-29](docs/GUIDE.md#p-29-passer-en-mode-avancé-puis-revenir-en-mode-simple)).

**Consigne** : ne laissez aucun fichier de clés, ni aucun `.env` avec de vrais secrets, dans le dossier des projets. L'outil de recherche de l'IA peut en afficher des lignes sans vous demander ([E-08](docs/GUIDE.md#e-08-ce-que-le-cockpit-ne-peut-pas-empêcher)).

## Ce qui sort sur le réseau

- Tout est bloqué **sur le poste**, sauf ce dont le cockpit a besoin pour GitHub Copilot. Le blocage a lieu avant le proxy de l'entreprise : un site refusé n'apparaît jamais dans ses journaux.
- opencode n'a aucun accès direct au réseau. Sa seule sortie est un relais du cockpit, qui ne laisse passer qu'une liste fermée :
  - l'adresse de l'API Copilot réellement utilisée ;
  - `github.com`, seulement pendant une connexion lancée depuis le cockpit, et au plus 20 minutes après la dernière demande de code ;
  - le domaine GitHub Enterprise déclaré, seulement pendant une connexion.
- Tout le reste est refusé sur place : `models.opencode.ai`, `registry.npmjs.org`, `api.github.com`, les pages web, les commandes de l'IA (`curl`, `git push`, `npm`, `pip`…).
- L'assistant ne va pas sur Internet ([E-03](docs/GUIDE.md#e-03-pourquoi-internet-est-fermé-depuis-la-110)).
- Le cockpit lui-même passe par le proxy de l'entreprise, s'il y en a un, pour l'API Copilot. Il ne contacte `api.github.com` que pour le solde facultatif et, sans adresse imposée, pour lire l'adresse de votre abonnement quand l'adresse générale est bloquée (au plus une fois par heure). Il n'envoie aucune télémétrie et ne partage rien publiquement. Le bouton [Tester la connexion Copilot] de **Diagnostic** n'essaie que l'adresse de l'API Copilot utilisée, jamais `api.github.com` ni `github.com` ([R-09](docs/GUIDE.md#r-09-ce-qui-sort-ce-qui-est-bloqué)).
- Aucun nom interne ne part vers le DNS de l'entreprise : le nom « opencode », comme tout nom sans point, reste dans Docker, même quand opencode est arrêté, et même quand le poste a un domaine de recherche DNS ([R-09](docs/GUIDE.md#r-09-ce-qui-sort-ce-qui-est-bloqué)).
- Le démarrage ne télécharge ni ne construit aucune image. Seules l'installation et la mise à jour en mode Build ou Pull téléchargent ([R-04](docs/GUIDE.md#r-04-trois-façons-dobtenir-les-images)).
- Au travail, trois réglages :
  - imposer l'adresse Copilot de votre abonnement : le cockpit ne lit alors plus rien sur `api.github.com`, hors solde facultatif ([P-12](docs/GUIDE.md#p-12-imposer-ladresse-copilot-de-votre-abonnement)) ;
  - faire les mises à jour avec l'archive hors ligne ([P-03](docs/GUIDE.md#p-03-vérifier-et-charger-larchive-dimages-hors-ligne)) ;
  - couper Kubernetes dans Docker Desktop s'il ne sert pas ([R-10](docs/GUIDE.md#r-10-poste-de-travail-réglages-conseillés)).
- L'accès au cockpit se fait par `127.0.0.1` seulement, en HTTPS local (ou en HTTP local s'il a été choisi, [P-04](docs/GUIDE.md#p-04-passer-en-mode-http-local)), avec un jeton de 256 bits. Le lien de connexion est à usage unique et valable 10 minutes ([E-12](docs/GUIDE.md#e-12-comment-laccès-au-cockpit-est-protégé)).
- Détail : [R-09](docs/GUIDE.md#r-09-ce-qui-sort-ce-qui-est-bloqué) et [E-01](docs/GUIDE.md#e-01-pourquoi-tout-est-bloqué-sauf-github-copilot) du guide, et la [section Sécurité du récapitulatif](docs/RECAPITULATIF.md#8-sécurité).

## Commandes du quotidien

**Chaque jour.** Le cockpit tourne tant que Docker Desktop tourne ; ses conteneurs repartent avec lui, sauf après `.\cockpit.ps1 stop`. Après un redémarrage du PC : démarrer Docker Desktop s'il ne se lance pas avec Windows, attendre qu'il soit prêt, puis lancer `.\cockpit.ps1 open`.

**Où lancer les commandes.** Toutes se lancent dans Windows PowerShell, depuis le dossier du cockpit. Dans une fenêtre neuve, aller d'abord dans ce dossier : `cd $env:USERPROFILE\opencode-cockpit`, si le cockpit a été récupéré comme à l'étape 1 de l'[installation](#installation). Si Windows répond que l'exécution de scripts est désactivée sur ce système, ajouter `powershell -ExecutionPolicy Bypass -File` devant la commande, par exemple `powershell -ExecutionPolicy Bypass -File .\cockpit.ps1 open` ([X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer)).

```powershell
.\cockpit.ps1 open               # vérifie le cockpit, puis ouvre l'interface déjà connectée
.\cockpit.ps1 status             # état des conteneurs et du cockpit, empreinte et échéance du certificat
.\cockpit.ps1 stop               # arrête les conteneurs ; .\cockpit.ps1 start les relance
.\cockpit.ps1 restart            # recrée les conteneurs : applique un changement de .env ou de certs\
.\cockpit.ps1 logs               # 200 dernières lignes, puis suivi (logs opencode, logs cockpit)
.\cockpit.ps1 diag               # diagnostic en lecture seule
.\cockpit.ps1 update             # mise à jour : git pull, puis install.ps1 dans le même mode
.\cockpit.ps1 backup             # sauvegarde dans backups\ (conteneurs arrêtés un instant)
.\cockpit.ps1 restore <fichier>  # IRRÉVERSIBLE : remplace les données actuelles
.\cockpit.ps1 tls                # certificat HTTPS local : empreinte, dates, noms couverts
.\cockpit.ps1 certs              # réexporte les certificats de Windows, puis recrée les conteneurs
.\cockpit.ps1 help               # aide des commandes
```

- Le suivi de `logs` s'arrête avec **Ctrl+C**.
- Mots à taper pour confirmer : `RESTAURER` pour `restore`, `SUPPRIMER` pour `uninstall -Purge`, `RENOUVELER` pour `tls -Renew`.
- **N'utilisez pas `.\cockpit.ps1 rollback` depuis la 1.1.0** : il ne ramène jamais à la 1.0.6. Le retour à la 1.0.6 est [P-09](docs/GUIDE.md#p-09-revenir-de-la-110-à-la-106).
- Désinstaller : [P-19](docs/GUIDE.md#p-19-désinstaller-le-cockpit-irréversible-avec--purge). Toutes les commandes de `cockpit.ps1` : [R-05](docs/GUIDE.md#r-05-commandes-de-cockpitps1). Options d'`install.ps1` : [R-02](docs/GUIDE.md#r-02-ce-que-fait-installps1-et-ses-options).

## Pannes les plus courantes

Elles sont classées par ce que vous voyez. Toutes les autres sont dans la [partie Pannes du guide](docs/GUIDE.md#pannes-classées-par-ce-que-vous-voyez).

| Ce que vous voyez | Première action | Guide |
|---|---|---|
| PowerShell refuse de lancer le script | Exécution de scripts désactivée : ajouter `powershell -ExecutionPolicy Bypass -File` devant la commande. Fichiers venus d'un ZIP : `Unblock-File .\install.ps1, .\cockpit.ps1, .\CockpitTls.ps1` | [X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer) |
| Page d'erreur du navigateur avec le code `ERR_CONNECTION_REFUSED` | Démarrer Docker Desktop, attendre qu'il soit prêt, puis `.\cockpit.ps1 start` et `.\cockpit.ps1 open` | [X-94](docs/GUIDE.md#x-94-page-derreur-err_connection_refused-à-louverture-du-cockpit) |
| « Edge interdit de passer l'avertissement de certificat sur ce poste » | Demander l'exception Edge à l'informatique | [X-05](docs/GUIDE.md#x-05-edge-interdit-de-passer-lavertissement-de-certificat) |
| « [!] Proxy '…' donne par un nom court : le DNS de Windows ne le developpe pas en nom complet » | `.\install.ps1 -Proxy http://<nom.complet>:<port>`, avec le nom complet du proxy ou son adresse IP | [X-22](docs/GUIDE.md#x-22-avertissement-ou-arrêt-sur-le-proxy-https-socks5-ou-nom-court) |
| « Votre connexion n'est pas privée » | Comparer l'empreinte, puis continuer | [X-30](docs/GUIDE.md#x-30-avertissement-de-certificat-au-premier-accès) |
| « 127.0.0.1 est actuellement inaccessible », sans bouton « Continuer » | Lancer `.\install.ps1 -TlsPreflight`, puis ouvrir `edge://policy` ([P-01](docs/GUIDE.md#p-01-vérifier-un-poste-dentreprise-avant-dinstaller)) | [X-31](docs/GUIDE.md#x-31-page-127001-inaccessible-sans-bouton-continuer) |
| Écran « Accès protégé par jeton » | `.\cockpit.ps1 open` | [X-34](docs/GUIDE.md#x-34-écran-de-connexion-du-cockpit) |
| « Hôte non autorisé » | Ouvrir `https://127.0.0.1:7777` | [X-35](docs/GUIDE.md#x-35-hôte-non-autorisé) |
| Bannière « Connexion au cockpit perdue » | Bouton [Recharger] | [X-38](docs/GUIDE.md#x-38-bannière-connexion-au-cockpit-perdue) |
| « GitHub Copilot n'est pas connecté. » | **Paramètres › Connexion** | [X-41](docs/GUIDE.md#x-41-github-copilot-nest-pas-connecté) |
| `SELF_SIGNED_CERT_IN_CHAIN` dans le journal d'opencode | `.\cockpit.ps1 certs` | [X-74](docs/GUIDE.md#x-74-erreur-de-certificat-ou-de-proxy-dans-le-journal-dopencode) |
| `AI_APICallError` à chaque demande | **Diagnostic**, bouton [Tester la connexion Copilot] | [X-42](docs/GUIDE.md#x-42-chaque-demande-échoue-avec-ai_apicallerror) |
| « Action réservée au mode Avancé (Paramètres › Affichage). » | Rien à réparer : cette action n'existe qu'en mode Avancé ([P-29](docs/GUIDE.md#p-29-passer-en-mode-avancé-puis-revenir-en-mode-simple)) | [X-63](docs/GUIDE.md#x-63-action-réservée-au-mode-avancé) |
| Une demande « consulter une page web » attend votre accord | La refuser | [X-52](docs/GUIDE.md#x-52-une-demande-web-attend-votre-accord) |
| « Liste des demandes d'autorisation illisible : … » | Refuser la demande affichée ; sinon [Arrêter], puis **Diagnostic**, [Redémarrer opencode] | [X-53](docs/GUIDE.md#x-53-liste-des-demandes-dautorisation-illisible) |

Les messages des scripts sont écrits sans accent. Le guide les cite tels quels, pannes [X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer) à [X-27](docs/GUIDE.md#x-27-salle-omo-non-démarrée-par-cockpitps1).

## Où trouver le reste

Le guide commence par un [index par sujet](docs/GUIDE.md#index-par-sujet). En voici l'essentiel :

| Sujet | Dans le guide |
|---|---|
| Installer, mettre à jour, entretenir | [P-01](docs/GUIDE.md#p-01-vérifier-un-poste-dentreprise-avant-dinstaller) à [P-20](docs/GUIDE.md#p-20-charger-limage-de-la-salle-omo-facultatif-la-salle-reste-coupée), [R-01](docs/GUIDE.md#r-01-prérequis-du-poste) à [R-12](docs/GUIDE.md#r-12-contenu-dune-sauvegarde) |
| Connexion, assistants, niveaux d'IA | [P-21](docs/GUIDE.md#p-21-connecter-github-copilot) à [P-25](docs/GUIDE.md#p-25-compléter-un-agent-créé-avant-la-10), [R-13](docs/GUIDE.md#r-13-vocabulaire-du-cockpit) à [R-17](docs/GUIDE.md#r-17-niveaux-dia) |
| Chat, travail en direct, travail délégué | [P-26](docs/GUIDE.md#p-26-répondre-à-une-demande-dautorisation) à [P-31](docs/GUIDE.md#p-31-voir-une-démonstration-du-travail-en-direct), [R-18](docs/GUIDE.md#r-18-qui-travaille) à [R-21](docs/GUIDE.md#r-21-travail-délégué-selon-le-mode-et-le-choix) |
| Autonomie et Internet fermé | [P-32](docs/GUIDE.md#p-32-laisser-lia-modifier-les-fichiers-sans-demander) à [P-37](docs/GUIDE.md#p-37-revenir-au-profil-prudent-irréversible-sans-sauvegarde), [R-22](docs/GUIDE.md#r-22-les-quatre-choix-dautonomie) à [R-28](docs/GUIDE.md#r-28-profils-de-droits-dopencode-et-configuration-par-défaut) |
| Onglet Fichiers | [P-38](docs/GUIDE.md#p-38-relire-un-fichier-que-lia-vient-décrire), [R-30](docs/GUIDE.md#r-30-onglet-fichiers), [R-31](docs/GUIDE.md#r-31-onglet-fichiers-garanties-et-bornes) |
| Salle de contrôle et « Revoir » | [P-39](docs/GUIDE.md#p-39-ouvrir-la-salle-de-contrôle) à [P-41](docs/GUIDE.md#p-41-revenir-à-la-3d-sur-ce-poste), [R-32](docs/GUIDE.md#r-32-salle-de-contrôle-niveaux-et-adresses) à [R-34](docs/GUIDE.md#r-34-lecteur-de-revoir-et-copie-des-consignes) |
| Équipes, méthodes, Seconde lecture | [P-42](docs/GUIDE.md#p-42-installer-un-exemple-déquipe-puis-lancer-une-équipe) à [P-50](docs/GUIDE.md#p-50-demander-une-seconde-lecture), [R-35](docs/GUIDE.md#r-35-formes-et-bornes-dune-équipe) à [R-45](docs/GUIDE.md#r-45-démonstration-déquipe) |
| Coûts, archives, Studio | [P-51](docs/GUIDE.md#p-51-régler-le-budget-mensuel-et-les-seuils-dalerte) à [P-58](docs/GUIDE.md#p-58-modifier-les-consignes-globales-agentsmd), [R-46](docs/GUIDE.md#r-46-page-coûts-et-export-csv) à [R-49](docs/GUIDE.md#r-49-studio) |
| Pannes et explications | [X-01](docs/GUIDE.md#x-01-le-script-refuse-de-se-lancer) à [X-94](docs/GUIDE.md#x-94-page-derreur-err_connection_refused-à-louverture-du-cockpit), [E-01](docs/GUIDE.md#e-01-pourquoi-tout-est-bloqué-sauf-github-copilot) à [E-26](docs/GUIDE.md#e-26-pourquoi-la-liste-des-demandes-dautorisation-est-reconstituée) |

Autres documents :

- [docs/RECAPITULATIF.md](docs/RECAPITULATIF.md) : fonctionnement, sécurité, validations, [limites et points à vérifier](docs/RECAPITULATIF.md#11-limites-et-points-à-vérifier), [référence du fichier `.env`](docs/RECAPITULATIF.md#13-référence--fichier-env).
- [docs/NOTES-1.1.0.md](docs/NOTES-1.1.0.md) : notes de la version et [retour arrière](docs/NOTES-1.1.0.md#retour-arrière).
- [docs/DEVELOPPEMENT.md](docs/DEVELOPPEMENT.md) : développer, tester et publier.
- [certs/README.md](certs/README.md) : certificats d'entreprise.

## Licence

MIT. opencode est un projet MIT d'Anomaly (anciennement SST).

<!-- [3d] début : licence de three.js (itération 3, DOC-3D) -->

La salle de contrôle en 3D utilise **three.js 0.186.0**, publié sous licence MIT. Sa licence est livrée avec l'interface, dans `licences/three-LICENSE.txt`, et le build échoue si elle manque.

<!-- [3d] fin -->
