# opencode cockpit 1.0.6 : notes de version

Version corrective de la 1.0.5. À installer au travail : plus aucun appel vers un site autre que GitHub Copilot ne part vers le proxy de l'entreprise.

## Pourquoi cette version

Au travail, opencode contactait des sites que le proxy de l'entreprise bloque : son catalogue de modèles (`models.opencode.ai`), au démarrage puis toutes les heures, et le registre npm (`registry.npmjs.org`). Chaque refus laissait une trace dans les journaux du proxy et déclenchait une alerte de sécurité.

## Ce qui change

- **opencode n'a plus aucun accès direct au réseau.** Sa seule sortie passe par le cockpit. Celui-ci ne laisse passer que GitHub Copilot : l'adresse de l'API Copilot que vous utilisez, et `github.com` (ou votre domaine GitHub Enterprise) seulement pendant une connexion à Copilot : un accès ouvert pendant la connexion est coupé à sa fin, même s'il sert encore. Tout le reste est refusé sur votre poste, sans rien envoyer au proxy de l'entreprise, et noté dans le journal du cockpit, au plus une fois par heure et par site. Une limite : le relais ne voit pas l'intérieur d'un tunnel ouvert vers l'adresse Copilot autorisée. Une commande fabriquée exprès, et que vous auriez approuvée, pourrait y faire passer un autre nom de site, que le proxy de l'entreprise pourrait noter dans ses journaux.
- **Plus de téléchargement du catalogue des modèles.** La liste de vos IA Copilot vient toujours de votre compte Copilot.
- **Plus d'installation depuis le registre npm.** L'extension dont opencode a besoin est livrée dans l'image, y compris pour une installation mise à jour.
- **Mot de passe interne renouvelé.** Jusqu'à la 1.0.5, opencode pouvait envoyer en clair au proxy de l'entreprise des appels à lui-même, avec le mot de passe qui protège son serveur. C'est corrigé, et la mise à jour remplace ce mot de passe toute seule.
- **Correctif de sécurité :** un dossier de projet au nom particulier pouvait faire sortir opencode du dossier des projets. Ces noms sont désormais refusés.
- **Diagnostic plus clair.** `.\cockpit.ps1 diag` indique pour chaque site s'il est bloqué sur le poste ou refusé par le proxy, et résume les refus des dernières 24 heures. Le test de connexion Copilot ne contacte plus que les adresses réellement utilisées.
- **Contrôles à l'installation.** `install.ps1` vérifie le domaine GitHub Enterprise déclaré et vous prévient si le proxy n'est pas indiqué en `http://`.

## Mettre à jour

1. `.\cockpit.ps1 update`, comme d'habitude.
   - Le mode d'accès ne change pas : HTTP local reste en HTTP, HTTPS reste en HTTPS.
   - Aucune reconnexion n'est demandée.
2. **Mode Load :** l'archive `opencode-cockpit-images-1.0.6.tar.gz` est obligatoire. Lancez `.\install.ps1 -Mode Load -ImagesArchive <archive>`.
3. Au travail, imposez une fois l'adresse Copilot de votre abonnement : c'est nécessaire pour ne laisser aucune trace au proxy de l'entreprise. `.\install.ps1 -CopilotApiUrl https://api.business.githubcopilot.com -NoBrowser` (ou `https://api.enterprise.githubcopilot.com`, selon votre abonnement). Sans cela, le cockpit essaie l'adresse générale `api.githubcopilot.com` au démarrage, puis environ toutes les heures, et ces tentatives passent par le proxy.
4. Vérifiez avec `.\cockpit.ps1 diag`, section « Acces reseau depuis le conteneur opencode ».
5. Conseil : si Kubernetes est activé dans Docker Desktop (Settings › Kubernetes) et que vous ne vous en servez pas, désactivez-le. Ses services sont visibles depuis le réseau interne d'opencode. Sans identifiants, ils ne permettent aucune sortie, mais mieux vaut les fermer.

Si un de vos dossiers de projets n'apparaît plus, son nom contient `%` suivi de deux chiffres ou lettres de A à F. Renommez-le. Un `%` seul, comme dans « Remise 20% », reste accepté.

`.\cockpit.ps1 rollback` ne ramène pas à la 1.0.5, mais à la version installée avant la 1.0.5, si elle a été mémorisée. Toute version antérieure fait revenir les appels décrits plus haut, et donc les alertes.
