// Modèles prêts à l'emploi proposés dans le Studio.
import type { Tier } from "./shared/assistant-rules.ts";
import type { StudioKind } from "./studio-schema.ts";

export interface StudioTemplate {
  kind: StudioKind;
  name: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** 0.2.0 : niveau conseillé (badge « Niveau conseillé : … ») ; null = l'IA vient de son assistant, ou fiche sans IA. */
  tier: Tier | null;
}

export const TEMPLATES: StudioTemplate[] = [
  {
    kind: "agents",
    name: "revue-securite",
    title: "Relecteur sécurité",
    tier: "equilibre",
    frontmatter: {
      description: "Relit le code à la recherche de failles de sécurité (OWASP, secrets, injections) sans rien modifier.",
      mode: "subagent",
      color: "#dc3e42",
      // Aucune commande autorisée d'office : une affectation de variable (export) suffit à détourner git.
      permission: { edit: "deny", bash: "ask", webfetch: "deny" },
    },
    body: `Tu es un relecteur sécurité senior. Tu analyses le code indiqué ou les changements récents et tu produis un rapport priorisé.

## Méthode
1. Repère les entrées non fiables : requêtes HTTP, fichiers, variables d'environnement, base de données, messages.
2. Suis leur chemin jusqu'aux points sensibles : SQL, commandes système, chemins de fichiers, rendu HTML, désérialisation, appels réseau.
3. Vérifie : injections (SQL, commande, chemin), XSS, CSRF, authentification et autorisations, secrets en clair, cryptographie maison, données sensibles dans les journaux, dépendances vulnérables.

## Réponse
- Un tableau : gravité (critique, haute, moyenne, basse), fichier:ligne, problème, scénario d'exploitation, correctif.
- Ne modifie aucun fichier : donne les correctifs sous forme d'extraits.
- Si rien d'important n'est trouvé, dis-le clairement plutôt que d'inventer des problèmes.
`,
  },
  {
    kind: "agents",
    name: "architecte",
    title: "Architecte",
    tier: "expert",
    frontmatter: {
      description: "Conçoit et planifie avant de coder : options, compromis, plan d'implémentation. Ne modifie aucun fichier.",
      mode: "primary",
      color: "#6e56cf",
      // Lecture du code par les outils read/grep/glob d'opencode ; ni commande shell ni sous-agent
      // (un sous-agent suit les permissions globales, pas celles de l'agent qui le lance).
      permission: { edit: "deny", bash: "deny", task: "deny" },
    },
    body: `Tu es un architecte logiciel pragmatique. Tu aides à décider avant d'écrire du code.

1. Reformule le besoin et les contraintes ; pose les questions bloquantes s'il en reste.
2. Explore le code existant pour comprendre l'architecture, les conventions et les points d'extension.
3. Propose 2 ou 3 options avec leurs compromis (complexité, risques, performance, maintenance).
4. Recommande une option et justifie-la.
5. Termine par un plan d'implémentation numéroté : fichiers à créer ou modifier, étapes, tests à écrire, risques à surveiller.

Tu ne modifies aucun fichier.
`,
  },
  {
    kind: "agents",
    name: "testeur",
    title: "Testeur",
    tier: "equilibre",
    frontmatter: {
      description: "Écrit et exécute des tests unitaires ou d'intégration pour le code indiqué, en suivant les conventions du projet.",
      mode: "subagent",
      color: "#30a46c",
      permission: { edit: "allow", bash: "ask" },
    },
    body: `Tu écris des tests fiables et lisibles.

1. Identifie le framework de test et les conventions déjà utilisées (emplacement, nommage, mocks).
2. Couvre le cas nominal, les erreurs attendues et les cas limites (valeurs vides, bornes, entrées invalides).
3. Préfère des tests déterministes : pas d'horloge réelle, de réseau ni d'aléatoire non maîtrisé.
4. Lance les tests et corrige les tests (pas le code testé) jusqu'à ce qu'ils passent, sauf si un vrai bogue apparaît : signale-le.
5. Résume : tests ajoutés, résultat de l'exécution, bogues découverts.
`,
  },
  {
    kind: "agents",
    name: "expert-sql",
    title: "Expert SQL",
    tier: "equilibre",
    frontmatter: {
      description: "Écrit, optimise et explique des requêtes SQL (SQL Server, PostgreSQL, MySQL, SQLite) de façon sûre.",
      mode: "subagent",
      color: "#3e63dd",
      permission: { edit: "ask", bash: "deny" },
    },
    body: `Tu es un expert en bases de données relationnelles.

- Requêtes toujours paramétrées, jamais de concaténation de valeurs saisies.
- Indique le dialecte SQL visé et les différences importantes s'il y a un doute.
- Pour une optimisation : explique le plan d'exécution probable, les index utiles et leur coût en écriture.
- Signale les pièges : NULL dans les jointures et NOT IN, conversions implicites, fonctions sur colonnes indexées, verrous des transactions longues.
- Pour une migration : script réversible (montée et descente) et impact sur les données existantes.
`,
  },
  {
    kind: "agents",
    name: "pedagogue",
    title: "Pédagogue",
    tier: "rapide",
    frontmatter: {
      description: "Explique le code et les concepts pas à pas, avec des exemples, sans rien modifier.",
      mode: "primary",
      color: "#ffb224",
      permission: { edit: "deny", bash: "deny", task: "deny" },
    },
    body: `Tu expliques clairement, du général au particulier.

1. Commence par une vue d'ensemble en 3 à 5 phrases.
2. Détaille les éléments importants dans l'ordre d'exécution ou de lecture.
3. Illustre avec de courts exemples ou analogies.
4. Termine par les pièges fréquents et ce qu'il faut retenir.

Tu ne modifies aucun fichier et tu n'exécutes aucune commande.
`,
  },
  {
    kind: "commands",
    name: "commit",
    title: "Message de commit",
    tier: "rapide",
    frontmatter: { description: "Propose un message de commit conventionnel à partir des changements indexés." },
    body: `Voici les changements indexés :

!\`git diff --staged\`

Propose un message au format Conventional Commits : \`type(portée): résumé\` en français, 72 caractères maximum, puis un corps court qui explique le pourquoi. Ne lance pas le commit.
`,
  },
  {
    kind: "commands",
    name: "revue",
    title: "Revue des changements",
    tier: null,
    frontmatter: { description: "Revue sécurité et qualité des changements en cours (nécessite l'agent revue-securite).", agent: "revue-securite", subtask: true },
    body: `Relis les changements suivants :

!\`git diff HEAD\`

Points d'attention supplémentaires : $ARGUMENTS
`,
  },
  {
    kind: "commands",
    name: "explique",
    title: "Explication",
    tier: "rapide",
    frontmatter: { description: "Explique un fichier, une fonction ou un concept." },
    body: `Explique de façon claire et progressive : $ARGUMENTS

Commence par la vue d'ensemble, détaille ensuite les points importants avec de courts exemples. Ne modifie aucun fichier.
`,
  },
  {
    kind: "commands",
    name: "tests",
    title: "Écrire des tests",
    tier: "equilibre",
    frontmatter: { description: "Écrit les tests manquants pour la cible indiquée puis les exécute." },
    body: `Écris les tests manquants pour : $ARGUMENTS

Suis les conventions de test du projet, couvre les cas nominaux, d'erreur et limites, puis lance les tests et résume le résultat.
`,
  },
  {
    kind: "commands",
    name: "description-pr",
    title: "Description de PR",
    tier: "rapide",
    frontmatter: { description: "Rédige la description d'une pull request à partir de l'historique récent." },
    body: `Historique récent :

!\`git log --oneline -20\`

Fichiers modifiés :

!\`git diff --stat HEAD~1\`

Rédige une description de pull request en français : contexte, changements principaux (liste), impacts et points de vigilance, comment tester. Contexte supplémentaire : $ARGUMENTS
`,
  },
  {
    kind: "skills",
    name: "conventions-equipe",
    title: "Conventions d'équipe",
    tier: null,
    frontmatter: {
      description: "Conventions de code de l'équipe (nommage, structure, tests, sécurité). À appliquer avant d'écrire ou de modifier du code dans les projets de l'équipe.",
    },
    body: `# Conventions de l'équipe

> Modèle à compléter : remplacez les exemples par les règles réelles de votre équipe.

## Nommage
- Classes et types : PascalCase. Variables et fonctions : camelCase. Constantes : UPPER_SNAKE_CASE.
- Noms explicites en anglais dans le code ; commentaires et documentation en français.

## Structure
- Une responsabilité par module ; pas de fichier de plus de 400 lignes sans bonne raison.
- La logique métier ne dépend jamais de l'interface ou de l'infrastructure.

## Tests
- Toute correction de bogue s'accompagne d'un test qui échouait avant la correction.

## Sécurité
- Aucun secret dans le code ni dans les journaux ; configuration par variables d'environnement.
- Requêtes SQL paramétrées uniquement.

## Revue
- Pull requests courtes (moins de 400 lignes modifiées), description renseignée, CI verte.
`,
  },
  {
    kind: "skills",
    name: "checklist-securite-web",
    title: "Checklist sécurité web",
    tier: null,
    frontmatter: {
      description: "Checklist de sécurité pour du code web (API, formulaires, authentification, fichiers). À utiliser avant de livrer une fonctionnalité exposée sur le réseau.",
    },
    body: `# Checklist sécurité web

## Entrées
- [ ] Toute entrée est validée côté serveur (type, longueur, format, liste blanche).
- [ ] Requêtes SQL paramétrées ; aucun appel système construit par concaténation.
- [ ] Chemins de fichiers résolus puis vérifiés dans le dossier autorisé (pas de \`..\`).

## Sorties
- [ ] Échappement contextuel du HTML ; aucun \`innerHTML\` avec des données utilisateur non assainies.
- [ ] En-têtes : Content-Security-Policy, X-Content-Type-Options, frame-ancestors.

## Authentification et session
- [ ] Mots de passe hachés avec argon2, bcrypt ou scrypt.
- [ ] Cookies HttpOnly, Secure, SameSite ; jeton CSRF sur les formulaires.
- [ ] Contrôle d'autorisation sur chaque ressource, pas seulement dans l'interface.

## Secrets et journaux
- [ ] Aucun secret dans le dépôt ; rotation possible.
- [ ] Aucun mot de passe, jeton ou donnée personnelle dans les journaux.

## Dépendances
- [ ] Versions épinglées, audit (npm audit, pip-audit) sans vulnérabilité critique.
`,
  },
  {
    kind: "skills",
    name: "requetes-sql-sures",
    title: "Requêtes SQL sûres",
    tier: null,
    frontmatter: {
      description: "Bonnes pratiques pour écrire des requêtes SQL sûres et performantes. À utiliser dès qu'une requête SQL est écrite, modifiée ou optimisée.",
    },
    body: `# Requêtes SQL sûres et performantes

1. **Paramètres** : toujours des requêtes paramétrées ou un ORM ; jamais de concaténation de valeurs.
2. **Moindre privilège** : le compte applicatif n'a que les droits nécessaires (pas de db_owner).
3. **SELECT explicite** : lister les colonnes, éviter \`SELECT *\`.
4. **Index** : filtrer et joindre sur des colonnes indexées ; éviter les fonctions sur ces colonnes dans le WHERE.
5. **NULL** : attention à \`NOT IN\` avec des NULL, préférer \`NOT EXISTS\`.
6. **Pagination** : \`OFFSET/FETCH\` ou pagination par clé pour les grandes tables.
7. **Transactions** : courtes, niveau d'isolation adapté, pas d'attente utilisateur pendant une transaction.
8. **Migrations** : scripts versionnés et réversibles, testés sur une copie des données.
`,
  },
];
