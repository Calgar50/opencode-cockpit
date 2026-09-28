# opencode cockpit 1.1.0 : notes de version

Version qui réunit les travaux du chantier 1.1 : voir qui travaille, borner et arrêter ce travail, l'autonomie à la demande, les équipes d'assistants, la construction et les méthodes, la salle de contrôle et « Revoir », et l'onglet Fichiers. Elle garde tout ce que la 1.0.6 a apporté au travail : plus aucun appel vers un site autre que GitHub Copilot ne part vers le proxy de l'entreprise. Et l'assistant ne va plus sur Internet.

## Pourquoi cette version

- **Voir et borner le travail des assistants.** Une demande peut faire travailler plusieurs assistants à la fois. La 1.1.0 montre qui travaille, pour combien, et arrête tout d'un seul geste ; elle permet aussi de laisser l'IA enchaîner le travail, dans des limites que le cockpit applique lui-même.
- **Fermer Internet pour de bon.** Depuis la 1.0.6, le cockpit ne laisse sortir que GitHub Copilot : une consultation d'Internet échouait donc toujours au travail. Mais la demande d'autorisation qu'elle posait restait possible, et opencode 1.18.30 ne sait plus lister ses demandes quand l'une d'elles, restée sans réponse, omet un réglage facultatif (mesuré) : « Autoriser une fois » ne passait plus pour les autres demandes du même dossier, jusqu'au refus de la demande en cause. La 1.1.0 refuse la consultation d'Internet dans les profils de droits, ferme ces règles dans une installation existante à la mise à jour, et le cockpit tient sa propre liste des demandes en attente.

## Ce qui change

- **« Qui travaille ? », Déroulé et carte du travail en direct** : chaque assistant au travail pour votre demande, son état, sa durée et son coût. **Arrêter** arrête toute la conversation, travail délégué compris. **Plan d'abord** fait écrire un plan dans une conversation qui ne peut rien modifier.
- **Autonomie à la demande** : quatre choix par conversation (« Demander à chaque fois », « Modifications automatiques », « Plan d'abord », « Autonome avec contrôle »), des plafonds qui arrêtent le travail, et un Journal du contrôle qui dit qui a décidé quoi. En « Autonome avec contrôle », un travail délégué ne part seul que vers un assistant qui demande avant d'agir et avant de lire un `.env` (le sous-agent intégré `explore` n'en fait pas partie). L'IA de contrôle, qui juge les commandes inconnues du cockpit, est active par défaut sans l'épreuve de 60 programmes inconnus prévue avant publication (appels facturés, non faite) : coupez-la dans **Paramètres › Budget** si vous préférez que ces commandes attendent votre accord.
- **Salle de contrôle et « Revoir »** : une vue d'ensemble du travail en cours, en 3D si le poste la dessine bien, en 2D sinon, et le rejeu d'une demande passée, sans rien relancer ni facturer.
- **Équipes et carte des assistants** : plusieurs assistants sur une même demande, dans un ordre fixé, et une carte qui montre qui peut faire travailler qui. Les équipes sont complètes en mode Avancé et **fermées en mode Simple**, jusqu'aux recettes d'accessibilité.
- **Construction, méthodes et Seconde lecture** : rédaction et relecture, aiguillage, schéma modifiable (mode Avancé), méthodes attachées aux assistants, Seconde lecture par un autre assistant, chronologie d'une demande (mode Avancé), coûts et archives par équipe.
- **Onglet Fichiers** : relire en lecture seule les fichiers de vos projets, sans rien modifier et sans rien envoyer à une IA. Les fichiers protégés par leur nom (clés, mots de passe, historique git) ne sont ni ouverts ni listés, sauf, un instant, leurs noms lors d'une course de renommage sur Docker Desktop. Une copie de secret sous un nom ordinaire reste lisible, masquée au mieux (limites : `docs/RECAPITULATIF.md`, onglet Fichiers).
- **L'assistant ne va plus sur Internet.**
  - Les profils Prudent, Équilibré et Sans confirmation refusent la consultation d'Internet.
  - L'assistant de création n'a plus de case « Consulter Internet » ; le Studio ne propose plus que « Refuser » pour ces outils.
  - En mode Avancé, **Paramètres › opencode** refuse, quand vous l'introduisez, une valeur « ask » ou « allow » écrite pour `webfetch` ou `websearch`, un joker à « ask » qui s'applique à ces outils, ou une permission en texte à « ask ». Limite : retirer la ligne « deny », ou tout ouvrir à « allow » (joker `"*"` ou `"web*"`, `"permission": "allow"`), n'est pas refusé ; opencode permet alors ces outils sans rien demander, sans effet sur le réseau : le relais du cockpit n'ouvre que GitHub Copilot.
  - **Paramètres › Sécurité** signale un profil d'une version précédente et propose « Fermer l'accès à Internet » : votre profil est gardé, seul l'accès à Internet change. Il signale aussi une règle générale personnalisée qui demande encore Internet (avec « Revenir au profil Prudent », qui remplace aussi vos autres règles) et les assistants qui peuvent encore le demander ; **Diagnostic** le résume.
- **Liste des demandes d'autorisation** : quand opencode ne sait plus la rendre, le cockpit la reconstitue à partir des événements d'opencode ; quand il n'en est pas sûr, il le dit, affiche la demande en cause s'il la connaît, et conseille de la refuser. **Limite :** si le cockpit a redémarré pendant qu'une telle demande attendait, il ne la connaît plus et la liste reste bloquée pour ce dossier. Arrêtez alors les réponses en cours (**Arrêter**), puis **Diagnostic › Redémarrer opencode** (ou `.\cockpit.ps1 restart`).
- **Sauvegarde et restauration réparées** : depuis la 1.0.6, `.\cockpit.ps1 backup` et `.\cockpit.ps1 restore` s'arrêtaient en erreur sous Windows PowerShell 5.1, avant d'arrêter quoi que ce soit, faute de savoir lire la configuration de Docker Compose. Ils la lisent de nouveau. Une sauvegarde lancée avec la 1.0.6 a donc échoué : faites-en une après la mise à jour. Si le nom de votre installation reste illisible dans cette configuration, `install.ps1` et `cockpit.ps1` s'arrêtent avant de toucher aux conteneurs et aux volumes, au lieu de supposer le nom par défaut, qui pouvait être celui d'une autre installation.
- **Salle Oh My OpenAgent** : son code est dans la version, **livré coupé par le code** : aucune option de la 1.1.0 ne l'ouvre ; sa mise en service passera par une version dédiée.
- **Une annonce, une fois**, dans le chat et dans Assistants, résume ces nouveautés. En mode Simple, elle ne propose aucune équipe tant qu'elles y sont fermées.
- **Aucune dépendance nouvelle**, sauf three.js 0.186.0 pour la 3D, sous licence MIT.

Ces fonctions n'ont pas été éprouvées sur GitHub Copilot réel : les recettes facturées prévues n'ont pas été faites. Elles sont listées, avec leurs replis, dans `docs/RECAPITULATIF.md`, section « Limites et points à vérifier ».

## Mettre à jour

1. `.\cockpit.ps1 update`, comme d'habitude.
   - Depuis la 1.0.5 ou la 1.0.6 : le mode d'accès ne change pas (HTTP local reste en HTTP, HTTPS reste en HTTPS) et aucune reconnexion n'est demandée.
   - Depuis une version antérieure à la 1.0.5 : lisez d'abord « Mise à jour vers la 1.0.5 » dans le README (passage en HTTPS, nouveau jeton, une reconnexion).
   - Le mot de passe interne d'opencode n'est renouvelé que si vous venez d'une version antérieure à la 1.0.6.
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
