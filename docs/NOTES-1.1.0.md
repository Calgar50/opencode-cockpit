# opencode cockpit 1.1.0 : notes de version

Version qui réunit les travaux du chantier 1.1 : voir qui travaille, borner et arrêter ce travail, l'autonomie à la demande, les équipes d'assistants, la construction et les méthodes, la salle de contrôle et « Revoir », et l'onglet Fichiers. Elle garde tout ce que la 1.0.6 a apporté au travail : plus aucun appel vers un site autre que GitHub Copilot ne part vers le proxy de l'entreprise. Et l'assistant ne va plus sur Internet.

## Pourquoi cette version

- **Voir et borner le travail des assistants.** Une demande peut faire travailler plusieurs assistants à la fois. La 1.1.0 montre qui travaille, pour combien, et arrête tout d'un seul geste ; elle permet aussi de laisser l'IA enchaîner le travail, dans des limites que le cockpit applique lui-même.
- **Fermer Internet pour de bon.** Depuis la 1.0.6, le cockpit ne laisse sortir que GitHub Copilot : une consultation d'Internet échouait donc toujours au travail. Mais la demande d'autorisation qu'elle posait restait possible, et opencode 1.18.30 ne sait plus lister ses demandes quand l'une d'elles, restée sans réponse, omet un réglage facultatif (mesuré) : « Autoriser une fois » ne passait plus pour les autres demandes du même dossier, jusqu'au refus de la demande en cause. La 1.1.0 refuse la consultation d'Internet dans les profils de droits, ferme ces règles dans une installation existante à la mise à jour, et le cockpit tient sa propre liste des demandes en attente.

## Ce qui change

- **« Qui travaille ? », Déroulé et carte du travail en direct** : chaque assistant au travail pour votre demande, son état, sa durée et son coût. **Arrêter** arrête toute la conversation, travail délégué compris. **Plan d'abord** fait écrire un plan dans une conversation qui ne peut rien modifier.
- **Autonomie à la demande** : quatre choix par conversation (« Demander à chaque fois », « Modifications automatiques », « Plan d'abord », « Autonome avec contrôle »), des plafonds qui arrêtent le travail, et un Journal du contrôle qui dit qui a décidé quoi. En « Autonome avec contrôle », un travail délégué ne part seul que vers un assistant qui demande avant d'agir et avant de lire un `.env` (le sous-agent intégré `explore` n'en fait pas partie) ; en mode Avancé, la carte « Détails de la délégation » dit si l'assistant demandé lit les `.env` sans demander (ligne « Lire un .env »). L'IA de contrôle, qui juge les commandes inconnues du cockpit, est active par défaut sans l'épreuve de 60 programmes inconnus prévue avant publication (appels facturés, non faite) : coupez-la dans **Paramètres › Budget** si vous préférez que ces commandes attendent votre accord.
- **Salle de contrôle et « Revoir »** : une vue d'ensemble du travail en cours, en 3D si le poste la dessine bien, en 2D sinon, et le rejeu d'une demande passée, sans rien relancer ni facturer.
- **Équipes et carte des assistants** : plusieurs assistants sur une même demande, dans un ordre fixé, et une carte qui montre qui peut faire travailler qui. Les équipes sont complètes en mode Avancé et **fermées en mode Simple**, jusqu'aux recettes d'accessibilité.
- **Construction, méthodes et Seconde lecture** : rédaction et relecture, aiguillage, schéma modifiable (mode Avancé), méthodes attachées aux assistants, Seconde lecture par un autre assistant, chronologie d'une demande (mode Avancé), coûts et archives par équipe.
- **Onglet Fichiers** : relire en lecture seule les fichiers de vos projets, sans rien modifier et sans rien envoyer à une IA. Les fichiers protégés par leur nom (clés, mots de passe, historique git) ne sont ni ouverts ni listés, sauf, un instant, leurs noms lors d'une course de renommage sur Docker Desktop. Une copie de secret sous un nom ordinaire reste lisible, masquée au mieux (limites : `docs/RECAPITULATIF.md`, onglet Fichiers).
- **L'assistant ne va plus sur Internet.**
  - Les profils Prudent, Équilibré et Sans confirmation refusent la consultation d'Internet.
  - L'assistant de création n'a plus de case « Consulter Internet » ; le Studio ne propose plus que « Refuser » pour ces outils.
  - En mode Avancé, **Paramètres › opencode** refuse, quand vous l'introduisez, une valeur « ask » ou « allow » écrite pour `webfetch` ou `websearch`, un joker à « ask » qui s'applique à ces outils, ou une permission en texte à « ask ». Limite : retirer la ligne « deny », ou tout ouvrir à « allow » (joker `"*"` ou `"web*"`, `"permission": "allow"`), n'est pas refusé ; opencode permet alors ces outils sans rien demander, sans effet sur le réseau : le relais du cockpit n'ouvre que GitHub Copilot.
  - **Paramètres › Sécurité** signale un profil d'une version précédente et propose « Fermer l'accès à Internet » : votre profil est gardé, seul l'accès à Internet change. Il signale aussi une règle générale personnalisée qui demande encore Internet (avec « Revenir au profil Prudent », qui remplace aussi vos autres règles) et les assistants qui peuvent encore le demander ; **Diagnostic** le résume.
- **Réseau, mesuré avant la publication** : plus aucun nom interne vers le DNS de l'entreprise, aucun téléchargement au démarrage, moins de lectures sur `api.github.com`. Au banc espion, sur neuf postes simulés, le proxy de l'entreprise n'a reçu de la version mesurée que des adresses GitHub et Copilot. Ajouté après la mesure, donc pas mesuré : le cockpit demande au navigateur de ne pas résoudre d'avance le nom des liens qu'il affiche. Détail, résultats, conditions et limites : section « Réseau » de ces notes.
- **Messages de `restore` et de `uninstall -Purge`** : `.\cockpit.ps1 restore` et `.\cockpit.ps1 uninstall -Purge` disent désormais qu'ils remplacent ou effacent aussi les conversations et les assistants.
- **Liste des demandes d'autorisation** : quand opencode ne sait plus la rendre, le cockpit la reconstitue à partir des événements d'opencode ; quand il n'en est pas sûr, il le dit, affiche la demande en cause s'il la connaît, et conseille de la refuser. **Limite :** si le cockpit a redémarré pendant qu'une telle demande attendait, ou si elle est arrivée pendant une coupure du lien avec opencode, il ne la connaît pas et la liste reste bloquée pour ce dossier. Arrêtez alors les réponses en cours (**Arrêter**), puis **Diagnostic › Redémarrer opencode** (ou `.\cockpit.ps1 restart`).
- **Sauvegarde et restauration réparées** : depuis la 1.0.6, `.\cockpit.ps1 backup` et `.\cockpit.ps1 restore` s'arrêtaient en erreur sous Windows PowerShell 5.1, avant d'arrêter quoi que ce soit, faute de savoir lire la configuration de Docker Compose. Ils la lisent de nouveau. Une sauvegarde lancée avec la 1.0.6 a donc échoué : faites-en une après la mise à jour. Si le nom de votre installation reste illisible dans cette configuration, `install.ps1` et `cockpit.ps1` s'arrêtent avant de toucher aux conteneurs et aux volumes, au lieu de supposer le nom par défaut, qui pouvait être celui d'une autre installation.
- **Salle Oh My OpenAgent** : son code est dans la version, **livré coupé par le code** : aucune option de la 1.1.0 ne l'ouvre ; sa mise en service passera par une version dédiée.
- **Une annonce, une fois**, dans le chat et dans Assistants, résume ces nouveautés. En mode Simple, elle ne propose aucune équipe tant qu'elles y sont fermées.
- **Aucune dépendance nouvelle**, sauf three.js 0.186.0 pour la 3D, sous licence MIT.

Ces fonctions n'ont pas été éprouvées sur GitHub Copilot réel : les recettes facturées prévues n'ont pas été faites. Elles sont listées, avec leurs replis, dans `docs/RECAPITULATIF.md`, section « Limites et points à vérifier ».

## Réseau

**Ce qui change.**

- Une première mesure a trouvé une fuite de nom, corrigée : quand opencode était arrêté, Docker envoyait le nom « opencode » au DNS de l'entreprise (défaut antérieur à la 1.1.0). Le cockpit n'envoie plus aucun nom sans point au DNS de l'entreprise, ni ce nom complété par le domaine de recherche du poste. Un proxy donné par un nom court ne s'y résoudrait plus : `install.ps1` le remplace dans `.env` par son nom complet, trouvé par le DNS de Windows, ou s'arrête avant toute modification s'il ne le trouve pas.
- Le démarrage ne télécharge ni ne construit plus aucune image ; une image absente l'arrête (Docker Compose 2.8 ou plus récent exigé).
- **Diagnostic › Tester la connexion Copilot** n'essaie plus que l'adresse de l'API Copilot utilisée, jamais `api.github.com` ni `github.com`, pas même pour relire la liste des IA.
- Avec l'adresse Copilot imposée (`-CopilotApiUrl`), le cockpit ne lit plus l'adresse de l'abonnement sur `api.github.com`. Sans elle, il ne la lit que quand l'adresse générale est bloquée : une fois au démarrage du cockpit, puis au plus une fois par heure, même après un échec (mesuré : toutes les 75 minutes environ).
- La synchronisation automatique du solde réel (facultative, coupée par défaut) ne réessaie plus chaque minute après un échec : derrière un proxy qui refuse `api.github.com`, c'était un refus par minute. L'essai automatique suivant attend désormais au moins une heure, ou l'intervalle choisi s'il est plus long. **Paramètres › Budget** affiche l'erreur et l'heure de cet essai ; « Synchroniser maintenant » reste possible.
- Le cockpit demande au navigateur de ne pas résoudre d'avance le nom des liens qu'il affiche (réponse d'IA, fichier, source d'une méthode) : en-tête `X-DNS-Prefetch-Control: off` sur toutes ses réponses, et méta équivalente dans sa page. Chromium le fait d'office sur une page servie en HTTP (mode HTTP local). Les liens d'une réponse de l'IA s'ouvrent dans un nouvel onglet, sans adresse d'origine.

**Ce que la mesure a vu.** Au banc espion, repris de celui de la 1.0.6 : proxy et DNS de l'entreprise simulés, qui notent chaque connexion et chaque question de nom ; faux GitHub Copilot servi par inspection TLS (aucun appel réel, rien de facturé) ; paquets capturés ; vrai navigateur Edge sur le cockpit. Neuf postes simulés, en HTTPS, avec le fichier Compose de la version : configuration par défaut, adresse Business imposée, adresse générale bloquée avec et sans `api.github.com`, GitHub Enterprise, mises à jour depuis la 1.0.5 et la 1.0.6, configurations hostiles et par projet, serveurs de langage et formateurs, connexion complète, salle coupée.

- **Témoin** : une vraie installation 1.0.5, placée derrière le même banc, y a été vue sortir vers `models.opencode.ai` et `registry.npmjs.org`. Le banc voit donc une installation qui fuit.
- **Proxy de l'entreprise** : de la version mesurée (cockpit et opencode), il n'a reçu aucun hôte tiers, sur les neuf postes. Seulement des adresses GitHub et Copilot : jamais `opencode.ai`, `models.opencode.ai`, `models.dev`, `registry.npmjs.org`, ni aucun autre site ; `github.com` seulement pendant une connexion à Copilot. Les scripts lancés à la main sont comptés à part (« Actions explicites des scripts »).
- **Configuration d'entreprise** (adresse Business imposée, proxy qui refuse `api.github.com`, `github.com` et l'adresse générale) : trois conversations sur quatre aboutissent (`gpt-4.1`, absente du catalogue embarqué d'opencode, échoue avec l'adresse Business), et aucune requête ne part vers `api.github.com` en 66 minutes, avec un onglet du cockpit ouvert.
- **Nom « opencode »** : aucune question au DNS de l'entreprise pendant un arrêt d'opencode de 5 minutes, cockpit redémarré entre-temps, avec et sans domaine de recherche DNS du poste. Sans le correctif, le même essai en donne 180, et 360 avec un domaine de recherche.
- **Page du cockpit** : aucune requête hors de son origine, onglets ouverts plus d'une heure ; une image distante glissée dans une réponse est bloquée par la CSP avant toute requête.
- **Version mesurée** : `e374977`. Le code de l'application de la 1.1.0 n'en diffère que par deux points ; hors de l'application, seuls un message d'`install.ps1` (mode Load) et un commentaire de `.env.example` ont changé. La synchronisation du solde a été vérifiée à part au même banc : un essai refusé, puis plus aucun pendant les 12 minutes observées, contre un refus par minute avant. Le durcissement des liens de la page (en-tête et méta `X-DNS-Prefetch-Control`, attributs des liens d'une réponse) a été ajouté après la mesure.

**Admis, et dit.** Deux sorties du cockpit vers `api.github.com`, un point d'accès de GitHub pour Copilot :

- sans adresse Copilot imposée et adresse générale bloquée : la lecture de l'adresse de l'abonnement, une fois au démarrage, puis une fois toutes les 75 minutes environ (mesuré) ;
- la synchronisation automatique du solde, un réglage que vous activez vous-même (coupé par défaut) : à l'intervalle choisi, une heure après un échec, et une fois à chaque démarrage du cockpit. Au travail, laissez-la manuelle.

**Actions explicites des scripts, hors Copilot**, sur votre commande seulement :

- `.\cockpit.ps1 update` : `git pull`, vers `github.com` ;
- modes Build et Pull de l'installation : Docker Hub, Debian, npm, GHCR. Le mode Load ne télécharge rien d'Internet ;
- `install.ps1`, à chaque installation et mise à jour : la détection du proxy système de Windows, qui peut interroger le réseau de l'entreprise (WPAD, fichier PAC) quand la détection automatique est active ; et, pour un proxy donné par un nom court seulement, une question au DNS de Windows, pour trouver son nom complet. Ni l'une ni l'autre n'a été exercée au banc.

**Conditions et limites.**

- La protection des noms internes repose sur le DNS intégré de Docker : le réseau interne d'opencode ne transmet aucun nom, et, dans le cockpit, une question d'adresse (A ou AAAA) sur un nom sans point est répondue sur place. Elle a été mesurée avec le moteur Docker 29.8 : 29.8.1 dans la machine virtuelle de chaque poste simulé ; le poste de développement qui porte le banc a Docker Desktop 29.8.0. Une version plus ancienne n'a pas été éprouvée : gardez Docker Desktop à jour.
- Les réseaux du cockpit sont en IPv4 seulement, par choix.
- Edge contacte ses propres services (Bing, `edge.microsoft.com`, `login.live.com`, Office), y compris son remplissage automatique quand la page affiche un formulaire. Ce n'est pas le cockpit : ce trafic dépend de la politique d'Edge du poste.
- Avec `COCKPIT_PROJECT_CONFIG=1`, un greffon local apporté par un dépôt s'exécute dans opencode ; il reste contenu par le relais, comme toute commande d'opencode. Avec `0` (défaut), opencode ne charge pas la configuration `.opencode/` d'un dépôt : au banc, aucun serveur MCP ni aucune consigne qu'elle déclarait n'a été tenté. Il en a pourtant lu la liste des extensions : opencode 1.18.30 a tenté d'installer l'extension npm qu'elle déclarait ; npm étant hors ligne, rien n'est parti. Un greffon local n'a pas été essayé au banc réseau ; à la revue de sécurité de la 0.1.0, avec la même version d'opencode, il n'avait pas été exécuté avec `0`, et l'avait été avec `1`. À examiner après la 1.1.0.
- Pas mesuré : un vrai poste d'entreprise, avec son proxy, sa détection du proxy (WPAD, PAC), son DNS et son Docker Desktop, dont le passage de Docker Desktop vers le résolveur DNS de Windows ; un navigateur qui résout lui-même les noms (au banc, Edge n'en résolvait aucun : l'effet de l'en-tête `X-DNS-Prefetch-Control` n'y est pas mesuré).

Détail et chiffres : `docs/RECAPITULATIF.md`, section « Sécurité » (sorties réseau) et section « Validations réalisées ».

## Mettre à jour

1. `.\cockpit.ps1 update`, comme d'habitude.
   - Depuis la 1.0.5 ou la 1.0.6 : le mode d'accès ne change pas (HTTP local reste en HTTP, HTTPS reste en HTTPS) et aucune reconnexion n'est demandée.
   - Depuis une version antérieure à la 1.0.5 : lisez d'abord « Mettre à jour depuis une version antérieure à la 1.0.5 » dans le guide, `docs/GUIDE.md`, procédure P-07 (passage en HTTPS, nouveau jeton, une reconnexion).
   - Le mot de passe interne d'opencode n'est renouvelé que si vous venez d'une version antérieure à la 1.0.6.
   - Docker Compose 2.8 ou plus récent est exigé. Sinon, `install.ps1` s'arrête sans toucher à `.env`, aux images ni aux conteneurs, et l'ancien cockpit continue de tourner ; mais `git pull` a déjà amené les scripts de la 1.1.0, dont `.\cockpit.ps1 start` et `restart` échouent tant que Docker Compose n'est pas en 2.8 (option `--pull` inconnue). Mettez Docker Desktop à jour, puis lancez `.\install.ps1` (en mode Load, avec `-Mode Load -ImagesArchive <archive>`, point 4) : il termine la mise à jour.
   - Un proxy donné par un nom court (`http://proxy:8080`) est remplacé dans `.env` par son nom complet, trouvé par le DNS de Windows (« [OK] Proxy donne par le nom court … »). Si le DNS ne le trouve pas, le script s'arrête avant toute modification et l'ancien cockpit continue de tourner : lancez `.\install.ps1 -Proxy http://<nom.complet>:<port>`, avec le nom complet du proxy ou son adresse IP (en mode Load, ajoutez `-Mode Load -ImagesArchive <archive>`, point 4). Cette commande termine la mise à jour ; d'ici là, ni `.\cockpit.ps1 start` ni `restart` : le cockpit, recréé avec la protection de la 1.1.0, ne résoudrait plus le nom court.
2. **Internet est fermé tout seul pendant la mise à jour.**
   - Les profils Prudent, Équilibré et Sans confirmation gardent leur nom ; seul l'accès à Internet passe à « refusé ».
   - Pour des règles personnalisées, seules les valeurs « ask » de `webfetch` et `websearch` deviennent « deny ».
   - Ce passage est **rejoué à chaque mise à jour et à chaque restauration** (`install.ps1`, `.\cockpit.ps1 restore`) : un « ask » remis à la main repassera à « deny ».
   - L'ancien fichier est gardé à côté (`opencode.jsonc.avant-1.1.0`, dans le volume de configuration d'opencode, compris dans `.\cockpit.ps1 backup`).
   - Les cas laissés tels quels sont annoncés par l'installateur et signalés dans **Paramètres › Sécurité** : pour un profil d'une version précédente, il propose « Fermer l'accès à Internet » (profil gardé) ; pour une règle générale personnalisée qui demande encore Internet, « Revenir au profil Prudent » la ferme mais remplace aussi vos autres règles (en mode Avancé, **Paramètres › opencode** permet de ne fermer qu'Internet).
   - Avec `.\install.ps1 -NoStart`, les règles ne sont mises à jour que si opencode est arrêté ; sinon l'installateur le dit : relancez `.\install.ps1` sans `-NoStart`.
3. **Les assistants créés dans le cockpit ne sont pas modifiés** : ceux qui avaient « Consulter Internet » sont signalés dans **Paramètres › Sécurité**, et les ouvrir puis **Enregistrer** ferme Internet pour eux. Seuls les agents déclarés dans la configuration générale d'opencode (`agent.<nom>`, `mode.<nom>`) ont eu leurs règles Internet fermées.
4. **Mode Load :** l'archive `opencode-cockpit-images-1.1.0.tar.gz` est obligatoire. Lancez `.\install.ps1 -Mode Load -ImagesArchive <archive>`. Avec les images 1.0.6, le script s'arrête avant toute modification.
5. **Retour arrière :** voir ci-dessous.

## Retour arrière

**N'utilisez pas `.\cockpit.ps1 rollback` depuis la 1.1.0.** Il ne ramène jamais à la 1.0.6 : s'il a mémorisé une version, c'est celle d'avant la 1.0.5 (1.0.4 ou plus ancienne). Elle est servie en HTTP, en clair, et n'a pas le relais de la 1.0.6 : les appels vers d'autres sites que GitHub Copilot, et donc les alertes du proxy, reviendraient. Le plan affiché avant la confirmation le dit.

**Pour revenir à la 1.0.6** (réglages et conversations gardés) :

1. Faites d'abord une sauvegarde avec la 1.1.0 : `.\cockpit.ps1 backup`. Celle de la 1.0.6 échoue sous Windows PowerShell 5.1.
2. Reprenez les scripts de la 1.0.6 : `git checkout v1.0.6` dans le dossier du cockpit (ou les fichiers de la release 1.0.6, sans toucher à `.env`, `certs\`, `archives\` ni `backups\`). L'`install.ps1` de la 1.1.0 refuse les images 1.0.6.
3. Relancez l'`install.ps1` de la 1.0.6 dans votre mode habituel ; en mode Load : `.\install.ps1 -Mode Load -ImagesArchive opencode-cockpit-images-1.0.6.tar.gz`.
4. Pour revenir ensuite à la dernière version : `git checkout main`, puis `.\cockpit.ps1 update`.

Limites de la 1.0.6 : `backup` et `restore` y échouent sous Windows PowerShell 5.1, et une installation dont le nom de projet Docker Compose a été changé n'est pas prise en charge par ses scripts (ils visent le nom par défaut). Paramètres › Sécurité y affiche « Profil de droits : Personnalisé » : c'est normal, seules les règles Internet diffèrent, et elles sont plus sûres. Ne cliquez pas sur « Revenir au profil Prudent » : il remettrait les demandes d'accès à Internet, qui peuvent bloquer vos autorisations. La mise à jour suivante remet tout en ordre.
