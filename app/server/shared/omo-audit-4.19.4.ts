// Table machine de l'audit d'Oh My OpenAgent 4.19.4 (spécification §3.15.1 l.477-492, §3.7 l.308, §4.10 l.759, §5.7.3 l.970,
// G12 l.1226, JS-3, JS-9, M28 l.1296 ; plan d'exécution D-2b-10, D-2b-31, D-2b-47, fiche L20).
//
// Source UNIQUE de l'audit : le paquet npm `oh-my-openagent@4.19.4` (`dist/`, `dist/config/schema/*.d.ts`, `dist/index.js`,
// `package.json`), lu sans rien exécuter ni installer. Les colonnes « preuve » donnent le fichier source du paquet et le symbole
// à y chercher : ce dépôt ne recopie AUCUN extrait de code ni de consigne de l'extension (D-2b-31, licence SUL-1.0).
//
// Ce que la table sert :
// - `docs/omo-audit-4.19.4.md` : mêmes noms et mêmes décisions, en tables lisibles (test de cohérence) ;
// - `docker/opencode-omo/enums-4.19.4.json` : mêmes énumérations et mêmes valeurs épinglées, lues par la construction de l'image
//   et par son validateur (L15a, porte G14) ;
// - `compareAgentsToAudit` : porte G12, `GET /agent` de l'instance comparé à la table ;
// - `omo-audit-texts.ts` : tableau « Ce que l'extension fait sans demande » (§4.10), engendré depuis cette table.
//
// Trois faits de forme relevés dans le paquet, qui commandent tout le reste :
// - R1 : `disabled_tools` est comparé par égalité de nom sur un ensemble (`filterDisabledTools`) — aucun joker, aucun préfixe ;
// - R2 : `disabled_hooks`, `disabled_tools`, `disabled_agents`, `disabled_skills`, `disabled_mcps` et `disabled_providers` sont
//   des tableaux de chaînes libres au schéma : un nom faux passe la validation ;
// - R3 : un nom faux n'a alors AUCUN effet et ne produit AUCUN message ; d'où le validateur de noms de L15a (G14).
//
// Module pur (server/shared) : aucune lecture de fichier ici, la comparaison avec le JSON est faite par le test.
import type { AgentLite, Rule } from "./assistant-rules.ts";
import { type OmoRole, roleDeAgent } from "./omo-roles.ts";

export const OMO_VERSION = "4.19.4";

/**
 * « garder » : la fonction reste en service dans la salle (la clé est écrite pour la borner, ou laissée à son défaut sans danger).
 * « couper » : la fonction est mise hors service par une valeur épinglée, ou la clé reste absente parce que l'écrire l'ouvrirait.
 */
export type OmoDecision = "garder" | "couper";

/** Où vérifier le fait dans le paquet : chemin du source tel que le `dist` le cite, et symbole à y chercher. */
export interface OmoPreuve {
  fichier: string;
  symbole: string;
}

export interface OmoHookAudit {
  nom: string;
  decision: OmoDecision;
  /** L'extension le fait d'elle-même, sans passer par une demande d'autorisation (§4.10). */
  sansDemande: boolean;
  motif: string;
}

export interface OmoOutilAudit {
  nom: string;
  decision: OmoDecision;
  /** false seulement si l'outil appelle `ctx.ask` : `skill` et `monitor_start`, et eux seuls, dans toute la 4.19.4. */
  sansDemande: boolean;
  /** Condition d'enregistrement de l'outil, quand il n'est pas toujours présent. */
  condition: string | null;
  preuve: OmoPreuve;
  motif: string;
}

export interface OmoMcpAudit {
  nom: string;
  decision: OmoDecision;
  preuve: OmoPreuve;
  motif: string;
}

export interface OmoCompetenceAudit {
  nom: string;
  decision: OmoDecision;
  motif: string;
}

export interface OmoCommandeAudit {
  nom: string;
  decision: OmoDecision;
  motif: string;
}

/** Autorisation `allow` acceptée dans `GET /agent` après la configuration figée : aucune n'est accordée aujourd'hui. */
export interface OmoAutorisation {
  permission: string;
  pattern: string;
}

export interface OmoAgentAudit {
  /** Clé de configuration (`agents.<clé>`), jamais un `displayName` (JP-7). */
  cle: string;
  role: OmoRole;
  decision: OmoDecision;
  autorisations: readonly OmoAutorisation[];
  motif: string;
}

export interface OmoCleAudit {
  cle: string;
  decision: OmoDecision;
  /** Valeur épinglée dans `omo.jsonc`, ou null quand la clé reste absente. */
  valeur: unknown;
  motif: string;
}

export interface OmoFaitReseau {
  quoi: string;
  hote: string;
  preuve: OmoPreuve;
  /** Ce qui ferme la sortie dans la salle. */
  fermeturePar: string;
}

export interface OmoFaitDisque {
  quoi: string;
  chemin: string;
  preuve: OmoPreuve;
}

// --- Hooks : les 56 noms de HookNameSchema, avec une décision pour chacun ---------------------------------------------------------
//
// `ralph-loop` N'EST PAS un nom de hook en 4.19.4 : l'écrire dans `disabled_hooks` serait ignoré en silence (R2, R3). La boucle
// correspondante est devenue un alias déprécié de `goal` (`config/validate.ts`, `migrateRalphLoopConfig`) : elle se coupe par
// `goal.enabled: false`, le hook `goal` et l'absence de la clé `ralph_loop`.

export const HOOKS: readonly OmoHookAudit[] = [
  { nom: "agent-usage-reminder", decision: "garder", sansDemande: false, motif: "rappel de texte ajouté à la consigne ; n'agit ni sur le disque du projet ni sur le réseau" },
  {
    nom: "anthropic-context-window-limit-recovery",
    decision: "couper",
    sansDemande: false,
    motif: "réécrit des fichiers de messages dans le stockage des sessions et ne vise qu'Anthropic, absent de la salle (Copilot seul)",
  },
  { nom: "ast-grep-sg-provision", decision: "couper", sansDemande: true, motif: "télécharge un binaire ast-grep depuis une publication GitHub et l'écrit sur le disque" },
  { nom: "atlas", decision: "garder", sansDemande: true, motif: "orchestration du plan : le principe même du mode (JS-9)" },
  { nom: "auto-slash-command", decision: "couper", sansDemande: true, motif: "exécute un raccourci dès qu'un message commence par « / », sans demande" },
  { nom: "auto-update-checker", decision: "couper", sansDemande: true, motif: "interroge le registre npm et peut lancer une installation ; déclenche aussi le rafraîchissement des capacités des IA" },
  { nom: "background-notification", decision: "garder", sansDemande: false, motif: "range les avis de tâches de fond dans la consigne suivante ; reste dans la salle" },
  { nom: "bash-file-read-guard", decision: "garder", sansDemande: false, motif: "garde-fou : détourne la lecture de fichiers par une commande vers l'outil de lecture" },
  { nom: "category-skill-reminder", decision: "garder", sansDemande: false, motif: "rappel de texte sur les compétences disponibles" },
  { nom: "claude-code-hooks", decision: "couper", sansDemande: true, motif: "exécute les crochets déclarés par le dépôt (.claude/), y compris des appels vers une adresse déclarée (C2-1)" },
  { nom: "codegraph-bootstrap", decision: "couper", sansDemande: true, motif: "provisionne puis lance le service codegraph, téléchargé depuis le registre npm" },
  { nom: "comment-checker", decision: "couper", sansDemande: true, motif: "lance un programme et sort sur le réseau" },
  { nom: "compaction-context-injector", decision: "garder", sansDemande: false, motif: "remet du contexte après un résumé de mémoire ; texte seulement" },
  { nom: "compaction-todo-preserver", decision: "garder", sansDemande: false, motif: "garde la liste de tâches à travers un résumé de mémoire" },
  { nom: "delegate-task-retry", decision: "garder", sansDemande: true, motif: "reprend une délégation en échec, sans demande ; borné par les plafonds de la salle (§4.8.2)" },
  { nom: "directory-agents-injector", decision: "couper", sansDemande: true, motif: "JS-9 : ajoute d'office aux consignes des définitions d'agents trouvées dans le dépôt" },
  {
    nom: "directory-readme-injector",
    decision: "couper",
    sansDemande: true,
    motif: "ajoute d'office le contenu de fichiers du dépôt après chaque lecture : consigne grossie sans demande, coût non maîtrisé",
  },
  { nom: "edit-error-recovery", decision: "garder", sansDemande: false, motif: "rattrape une modification en échec ; texte seulement" },
  { nom: "empty-task-response-detector", decision: "garder", sansDemande: false, motif: "repère une délégation revenue sans réponse" },
  { nom: "fsync-skip-warning", decision: "garder", sansDemande: false, motif: "avertissement de texte" },
  { nom: "goal", decision: "couper", sansDemande: true, motif: "objectif persistant et outils create_goal, update_goal, get_goal : enchaînement hors de la demande (spéc. §3.15.1)" },
  { nom: "hashline-read-enhancer", decision: "couper", sansDemande: true, motif: "accompagne l'éditeur hashline, coupé par hashline_edit à false ; lance des programmes" },
  {
    nom: "hephaestus-agents-md-injector",
    decision: "couper",
    sansDemande: true,
    motif: "injecte les AGENTS.md du projet et de ses parents : consignes d'autorité venues d'un dépôt non fiable, même famille que rules-injector",
  },
  { nom: "interactive-bash-session", decision: "couper", sansDemande: true, motif: "suit des sessions de commandes interactives ; l'outil interactive_bash est coupé" },
  { nom: "json-error-recovery", decision: "garder", sansDemande: false, motif: "rattrape une réponse mal formée ; texte seulement" },
  { nom: "keyword-detector", decision: "garder", sansDemande: true, motif: "« ulw » et les mots-clés du mode : étend le message avant l'envoi (JS-9)" },
  { nom: "legacy-plugin-toast", decision: "couper", sansDemande: false, motif: "invite à lancer une installation de l'extension" },
  { nom: "model-fallback", decision: "couper", sansDemande: true, motif: "change d'IA sans le dire ; la salle n'utilise que github-copilot/* (JS-11, G3)" },
  { nom: "monitor-status-injector", decision: "couper", sansDemande: false, motif: "accompagne les outils monitor_*, coupés avec monitor.enabled à false" },
  { nom: "no-hephaestus-non-gpt", decision: "garder", sansDemande: false, motif: "avis affiché dans la TUI ; aucun effet sur les fichiers ni sur le réseau" },
  { nom: "no-sisyphus-gpt", decision: "garder", sansDemande: false, motif: "avis affiché dans la TUI ; aucun effet sur les fichiers ni sur le réseau" },
  {
    nom: "non-interactive-env",
    decision: "couper",
    sansDemande: true,
    motif: "ajoute des affectations d'environnement aux commandes : le texte classé par le cockpit (§4.5) ne serait plus celui exécuté",
  },
  { nom: "notepad-write-guard", decision: "garder", sansDemande: false, motif: "garde-fou d'écriture du carnet partagé" },
  { nom: "plan-format-validator", decision: "garder", sansDemande: false, motif: "vérifie la forme du plan ; texte seulement" },
  { nom: "preemptive-compaction", decision: "garder", sansDemande: true, motif: "résume la mémoire avant le plafond de contexte : appel d'IA sans demande, compté par les plafonds" },
  { nom: "prometheus-md-only", decision: "garder", sansDemande: false, motif: "restreint le planificateur aux fichiers .md : renfort de JS-3" },
  { nom: "question-label-truncator", decision: "garder", sansDemande: false, motif: "tronque un libellé ; texte seulement" },
  { nom: "read-image-resizer", decision: "garder", sansDemande: false, motif: "réduit une image lue avant de l'envoyer" },
  { nom: "rules-injector", decision: "couper", sansDemande: true, motif: "JS-9 : injecte les fichiers de règles du dépôt et du dossier personnel dans les consignes" },
  { nom: "runtime-fallback", decision: "couper", sansDemande: true, motif: "change de moteur d'exécution sans le dire" },
  { nom: "session-notification", decision: "couper", sansDemande: true, motif: "lance un programme du système pour notifier hors du cockpit" },
  { nom: "sisyphus-junior-notepad", decision: "garder", sansDemande: true, motif: "écrit le carnet partagé sous .omo/notepads : montré par la carte (JP-6)" },
  { nom: "start-work", decision: "garder", sansDemande: true, motif: "ouvre une séance de travail depuis un plan (JS-9) ; start_work.auto_commit est épinglé à false" },
  { nom: "startup-toast", decision: "garder", sansDemande: false, motif: "avis de démarrage dans la TUI" },
  {
    nom: "stop-continuation-guard",
    decision: "couper",
    sansDemande: false,
    motif: "frein de la commande stop-continuation, elle-même coupée : l'arrêt de la salle passe par la séquence du cockpit, jamais par une commande qui relancerait un tour (JS-1)",
  },
  { nom: "task-resume-info", decision: "garder", sansDemande: false, motif: "rappelle l'état d'un travail repris ; texte seulement" },
  { nom: "tasks-todowrite-disabler", decision: "garder", sansDemande: false, motif: "sans effet ici : le système de tâches de l'extension reste coupé" },
  { nom: "team-tool-gating", decision: "couper", sansDemande: false, motif: "Team Mode coupé (Q5, défaut signalé en amont sur opencode 1.18.30)" },
  { nom: "think-mode", decision: "garder", sansDemande: false, motif: "règle l'effort de réflexion demandé ; texte seulement" },
  { nom: "todo-continuation-enforcer", decision: "garder", sansDemande: true, motif: "relance la liste de tâches jusqu'au bout : le principe même du mode (JS-9)" },
  { nom: "todo-description-override", decision: "garder", sansDemande: false, motif: "réécrit le libellé d'une tâche ; texte seulement" },
  { nom: "tool-output-truncator", decision: "garder", sansDemande: false, motif: "tronque une sortie d'outil trop longue" },
  { nom: "tool-pair-validator", decision: "garder", sansDemande: false, motif: "vérifie l'appariement des appels d'outils ; texte seulement" },
  { nom: "unstable-agent-babysitter", decision: "garder", sansDemande: true, motif: "relance une IA restée muette, sans demande ; borné par les plafonds de la salle" },
  { nom: "webfetch-redirect-guard", decision: "couper", sansDemande: true, motif: "suit les redirections avant un appel web ; webfetch est refusé dans la salle" },
  { nom: "write-existing-file-guard", decision: "garder", sansDemande: false, motif: "garde-fou : refuse d'écraser un fichier existant qui n'a pas été lu" },
];

// --- Outils enregistrés par l'extension -------------------------------------------------------------------------------------------
//
// Deux outils, et deux seulement, demandent une autorisation (`ctx.ask`) : `skill` et `monitor_start`. Tous les autres agissent
// sans demande. Preuve : le paquet ne contient que deux appels de `ctx.ask`, dans `tools/skill/tools.ts` et
// `tools/monitor/monitor-start.ts`.
//
// Pièges de nom, relevés dans le paquet :
// - l'éditeur « hashline » s'enregistre sous le nom `edit` et remplace l'outil natif : écrire « hashline_edit » dans
//   `disabled_tools` n'aurait aucun effet (R1) ; la clé `hashline_edit: false` est le seul vrai levier ;
// - l'outil de délégation s'enregistre sous le nom `task` et remplace le `task` natif d'opencode.

const REGISTRE: OmoPreuve = { fichier: "packages/omo-opencode/src/plugin/tool-registry.ts", symbole: "createToolRegistry" };
const REGISTRE_TEAM: OmoPreuve = { fichier: "packages/omo-opencode/src/plugin/tool-registry-team-tools.ts", symbole: "createTeamModeToolsRecord" };
const OUTIL_TEAM = (nom: string): OmoOutilAudit => ({
  nom,
  decision: "couper",
  sansDemande: true,
  condition: "team_mode.enabled",
  preuve: REGISTRE_TEAM,
  motif: "Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives",
});

export const OUTILS: readonly OmoOutilAudit[] = [
  {
    nom: "grep",
    decision: "couper",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/grep/tools.ts", symbole: "createGrepTools" },
    motif: "remplace la recherche native et peut télécharger puis installer ripgrep (resolveGrepCliWithAutoInstall)",
  },
  {
    nom: "glob",
    decision: "couper",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/glob/tools.ts", symbole: "createGlobTools" },
    motif: "même moteur que grep, même installation automatique",
  },
  {
    nom: "session_list",
    decision: "couper",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/session-manager/tools.ts", symbole: "createSessionManagerTools" },
    motif: "lit le stockage des conversations de l'instance, hors du projet et hors de la demande en cours",
  },
  {
    nom: "session_read",
    decision: "couper",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/session-manager/tools.ts", symbole: "createSessionManagerTools" },
    motif: "lit le contenu d'autres conversations de l'instance",
  },
  {
    nom: "session_search",
    decision: "couper",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/session-manager/tools.ts", symbole: "createSessionManagerTools" },
    motif: "cherche dans le contenu d'autres conversations de l'instance",
  },
  {
    nom: "session_info",
    decision: "couper",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/session-manager/tools.ts", symbole: "createSessionManagerTools" },
    motif: "expose les métadonnées d'autres conversations de l'instance",
  },
  {
    nom: "background_output",
    decision: "garder",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/background-task/create-background-output.ts", symbole: "createBackgroundOutput" },
    motif: "relève le résultat d'une tâche de fond : le mode en dépend ; aucune action sur le disque ni sur le réseau",
  },
  {
    nom: "background_cancel",
    decision: "garder",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/background-task/create-background-cancel.ts", symbole: "createBackgroundCancel" },
    motif: "abandonne une tâche de fond : va dans le sens de l'arrêt",
  },
  {
    nom: "call_omo_agent",
    decision: "garder",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/call-omo-agent/tools.ts", symbole: "createCallOmoAgent" },
    motif: "confie du travail à un agent de l'extension : le principe du mode ; compté par les plafonds de sessions et de coût",
  },
  {
    nom: "look_at",
    decision: "couper",
    sansDemande: true,
    condition: "agent multimodal-looker actif",
    preuve: { fichier: "packages/omo-opencode/src/tools/look-at/tools.ts", symbole: "createLookAt" },
    motif: "envoie des fichiers (PDF, images) à une IA multimodale ; l'agent multimodal-looker est coupé (spéc. §3.15.1)",
  },
  {
    nom: "task",
    decision: "garder",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/delegate-task/tools.ts", symbole: "createDelegateTask" },
    motif: "délégation de l'extension, qui remplace le task natif : le principe du mode ; comptée et plafonnée",
  },
  {
    nom: "skill_mcp",
    decision: "couper",
    sansDemande: true,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/skill-mcp/tools.ts", symbole: "createSkillMcpTool" },
    motif: "démarre un serveur déclaré par une compétence, sans demande (D-2b-34)",
  },
  {
    nom: "skill",
    decision: "garder",
    sansDemande: false,
    condition: null,
    preuve: { fichier: "packages/omo-opencode/src/tools/skill/tools.ts", symbole: "createSkillTool" },
    motif: "charge une compétence intégrée ; seul outil de l'extension, avec monitor_start, à demander une autorisation",
  },
  {
    nom: "create_goal",
    decision: "couper",
    sansDemande: true,
    condition: "goal.enabled",
    preuve: { fichier: "packages/omo-opencode/src/hooks/goal/tools.ts", symbole: "createGoalTools" },
    motif: "objectif persistant : enchaînement hors de la demande ; le hook goal est coupé",
  },
  {
    nom: "update_goal",
    decision: "couper",
    sansDemande: true,
    condition: "goal.enabled",
    preuve: { fichier: "packages/omo-opencode/src/hooks/goal/tools.ts", symbole: "createGoalTools" },
    motif: "même objectif persistant",
  },
  {
    nom: "get_goal",
    decision: "couper",
    sansDemande: true,
    condition: "goal.enabled",
    preuve: { fichier: "packages/omo-opencode/src/hooks/goal/tools.ts", symbole: "createGoalTools" },
    motif: "même objectif persistant",
  },
  {
    nom: "interactive_bash",
    decision: "couper",
    sansDemande: true,
    condition: "tmux présent sur le chemin",
    preuve: { fichier: "packages/omo-opencode/src/tools/interactive-bash/tools.ts", symbole: "interactive_bash" },
    motif: "ouvre une session de commandes interactive hors du garde-fou de commandes du cockpit",
  },
  OUTIL_TEAM("team_create"),
  OUTIL_TEAM("team_delete"),
  OUTIL_TEAM("team_shutdown_request"),
  OUTIL_TEAM("team_approve_shutdown"),
  OUTIL_TEAM("team_reject_shutdown"),
  OUTIL_TEAM("team_send_message"),
  OUTIL_TEAM("team_task_create"),
  OUTIL_TEAM("team_task_list"),
  OUTIL_TEAM("team_task_update"),
  OUTIL_TEAM("team_task_get"),
  OUTIL_TEAM("team_status"),
  OUTIL_TEAM("team_list"),
  {
    nom: "monitor_start",
    decision: "couper",
    sansDemande: false,
    condition: "monitor.enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/monitor/monitor-start.ts", symbole: "createMonitorStart" },
    motif: "lance une commande surveillée en arrière-plan ; monitor.enabled est épinglé à false",
  },
  {
    nom: "monitor_stop",
    decision: "couper",
    sansDemande: true,
    condition: "monitor.enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/monitor/create-monitor-tools.ts", symbole: "createMonitorTools" },
    motif: "accompagne monitor_start, coupé",
  },
  {
    nom: "monitor_list",
    decision: "couper",
    sansDemande: true,
    condition: "monitor.enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/monitor/create-monitor-tools.ts", symbole: "createMonitorTools" },
    motif: "accompagne monitor_start, coupé",
  },
  {
    nom: "monitor_output",
    decision: "couper",
    sansDemande: true,
    condition: "monitor.enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/monitor/create-monitor-tools.ts", symbole: "createMonitorTools" },
    motif: "accompagne monitor_start, coupé",
  },
  {
    nom: "task_create",
    decision: "couper",
    sansDemande: true,
    condition: "new_task_system_enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/task/task-create.ts", symbole: "createTaskCreateTool" },
    motif: "second système de tâches ; le cockpit lit la liste de tâches native d'opencode (§5.7.3)",
  },
  {
    nom: "task_get",
    decision: "couper",
    sansDemande: true,
    condition: "new_task_system_enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/task/task-get.ts", symbole: "createTaskGetTool" },
    motif: "second système de tâches",
  },
  {
    nom: "task_list",
    decision: "couper",
    sansDemande: true,
    condition: "new_task_system_enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/task/task-list.ts", symbole: "createTaskList" },
    motif: "second système de tâches",
  },
  {
    nom: "task_update",
    decision: "couper",
    sansDemande: true,
    condition: "new_task_system_enabled",
    preuve: { fichier: "packages/omo-opencode/src/tools/task/task-update.ts", symbole: "createTaskUpdateTool" },
    motif: "second système de tâches",
  },
  {
    nom: "edit",
    decision: "couper",
    sansDemande: true,
    condition: "hashline_edit",
    preuve: { fichier: "packages/omo-opencode/src/tools/hashline-edit/tools.ts", symbole: "createHashlineEditTool" },
    motif: "l'éditeur hashline remplace l'outil natif sous le nom « edit » ; coupé par hashline_edit à false, jamais par disabled_tools",
  },
];

/** Outils dont le nom est écrit dans `disabled_tools` : ceux qui sont coupés et que l'extension enregistre sous ce nom. */
export const OUTILS_A_COUPER: readonly string[] = OUTILS.filter((o) => o.decision === "couper" && o.nom !== "edit").map((o) => o.nom);

// --- Serveurs MCP intégrés (McpNameSchema) ---------------------------------------------------------------------------------------

export const MCPS: readonly OmoMcpAudit[] = [
  {
    nom: "codegraph",
    decision: "couper",
    preuve: { fichier: "packages/utils/src/codegraph/provision.ts", symbole: "ensureCodegraphProvisioned" },
    motif: "service local dont le binaire est téléchargé depuis le registre npm et installé sous ~/.omo/codegraph",
  },
  {
    nom: "context7",
    decision: "couper",
    preuve: { fichier: "packages/omo-opencode/src/mcp/context7.ts", symbole: "createContext7Config" },
    motif: "serveur distant : sortie réseau vers un service tiers",
  },
  {
    nom: "grep_app",
    decision: "couper",
    preuve: { fichier: "packages/omo-opencode/src/mcp/grep-app.ts", symbole: "grep_app" },
    motif: "serveur distant : sortie réseau vers un service tiers",
  },
  {
    nom: "lsp",
    decision: "couper",
    preuve: { fichier: "packages/omo-opencode/src/mcp/lsp.ts", symbole: "createBootstrapCandidate" },
    motif: "serveur local dont l'amorçage lance npm ou bun quand le binaire n'est pas déjà là",
  },
  {
    nom: "websearch",
    decision: "couper",
    preuve: { fichier: "packages/omo-opencode/src/mcp/websearch.ts", symbole: "createWebsearchConfig" },
    motif: "serveur distant : recherche web, refusée dans la salle",
  },
];

// --- Compétences intégrées (BuiltinSkillNameSchema) --------------------------------------------------------------------------------

export const COMPETENCES: readonly OmoCompetenceAudit[] = [
  { nom: "agent-browser", decision: "couper", motif: "pilote un navigateur par un programme externe, à installer : réseau fermé dans la salle" },
  { nom: "debugging", decision: "garder", motif: "méthode de recherche de panne ; texte seulement" },
  { nom: "dev-browser", decision: "couper", motif: "pilote un navigateur persistant : réseau fermé dans la salle" },
  { nom: "frontend", decision: "garder", motif: "méthode de travail sur l'interface ; texte seulement" },
  { nom: "git-master", decision: "couper", motif: "l'historique git est monté en lecture seule (Q2) et l'envoi git est un interdit absolu : la compétence ne peut pas aboutir" },
  { nom: "init-deep", decision: "garder", motif: "écrit des AGENTS.md dans le projet, écriture permise et visible ; aucun réseau" },
  { nom: "playwright", decision: "couper", motif: "pilote un navigateur, installé à la demande : réseau fermé dans la salle" },
  { nom: "remove-ai-slops", decision: "garder", motif: "nettoyage de code par délégations, déjà plafonnées" },
  { nom: "review-work", decision: "garder", motif: "relecture par délégations, déjà plafonnées" },
  { nom: "security-research", decision: "couper", motif: "s'appuie sur Team Mode, coupé (Q5)" },
  { nom: "security-review", decision: "couper", motif: "alias de security-research, qui s'appuie sur Team Mode" },
  { nom: "team-mode", decision: "couper", motif: "Team Mode coupé (Q5)" },
  { nom: "visual-qa", decision: "couper", motif: "s'appuie sur le pilotage d'un navigateur, coupé" },
];

// --- Commandes intégrées (BuiltinCommandNameSchema) --------------------------------------------------------------------------------

export const COMMANDES: readonly OmoCommandeAudit[] = [
  { nom: "goal", decision: "couper", motif: "objectif persistant : enchaînement hors de la demande" },
  { nom: "hyperplan", decision: "garder", motif: "plan détaillé ; reste dans la demande" },
  { nom: "refactor", decision: "garder", motif: "travail sur le code du projet, déjà borné par les interdits et les plafonds" },
  { nom: "remove-ai-slops", decision: "garder", motif: "nettoyage de code ; délégations plafonnées" },
  { nom: "start-work", decision: "garder", motif: "ouverture d'une séance depuis un plan (JS-9) ; auto_commit épinglé à false" },
  { nom: "stop-continuation", decision: "couper", motif: "relancerait un tour facturé ; l'arrêt de la salle passe par la séquence du cockpit (JS-1)" },
];

// --- Agents : clés de configuration et autorisations attendues (G12, JS-3) ----------------------------------------------------------

const AGENT = (cle: string, decision: OmoDecision, motif: string): OmoAgentAudit => ({ cle, role: roleDeAgent(cle), decision, autorisations: [], motif });

export const AGENTS: readonly OmoAgentAudit[] = [
  AGENT("build", "garder", "agent natif d'opencode ; ses droits viennent de la configuration d'instance (edit, bash et task à « ask »)"),
  AGENT("plan", "garder", "agent natif d'opencode, en lecture et plan"),
  AGENT("sisyphus", "garder", "orchestrateur du mode : planifie, confie, relance"),
  AGENT("hephaestus", "garder", "exécutant autonome ; aucune autorisation « allow » attendue après la configuration d'instance"),
  AGENT("sisyphus-junior", "garder", "exécutant sans délégation"),
  AGENT("OpenCode-Builder", "garder", "variante d'exécutant ; mêmes droits que build"),
  AGENT("prometheus", "garder", "planificateur ; agents.prometheus.permission épinglé à edit « ask », bash « deny », webfetch « deny » (JS-3), au lieu de trois « allow » par défaut"),
  AGENT("metis", "garder", "conseil avant le plan ; lecture seule"),
  AGENT("momus", "garder", "relecture de plan ; lecture seule"),
  AGENT("oracle", "garder", "conseil sur les points durs ; lecture seule"),
  AGENT("librarian", "couper", "cherche dans des dépôts distants et récupère de la documentation : sortie réseau (spéc. §3.15.1)"),
  AGENT("explore", "garder", "recherche dans le projet ouvert"),
  AGENT("multimodal-looker", "couper", "envoie des fichiers à une IA multimodale ; retire aussi l'outil look_at du registre (spéc. §3.15.1)"),
  AGENT("atlas", "garder", "orchestration du plan (JS-9)"),
];

/** Permissions dont un `allow` non audité fait échouer la porte G12 (spéc. l.1226). */
export const PERMISSIONS_SENSIBLES: readonly string[] = ["edit", "bash", "webfetch", "external_directory", "read"];

// --- Fournisseurs cités par le paquet, autres que Copilot ---------------------------------------------------------------------------
//
// Seconde barrière derrière `enabled_providers: ["github-copilot"]` de la configuration d'instance : `disabled_providers` est
// comparé sans tenir compte de la casse et n'accepte aucun joker, d'où une liste de noms exacts.

export const FOURNISSEURS_COUPES: readonly string[] = [
  "aihubmix",
  "alibaba-token-plan",
  "alibaba-token-plan-cn",
  "anthropic",
  "anthropic-api",
  "bailian-coding-plan",
  "deepseek",
  "firmware",
  "google",
  "kimi-for-coding",
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
  "moonshotai",
  "moonshotai-cn",
  "ollama-cloud",
  "openai",
  "opencode",
  "opencode-go",
  "quotio-openai",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "vercel",
  "xai",
  "xiaomi",
  "zai-coding-plan",
];

// --- Clés de configuration de premier niveau (46) ----------------------------------------------------------------------------------

export const CLES: readonly OmoCleAudit[] = [
  { cle: "$schema", decision: "couper", valeur: null, motif: "non écrite : elle désigne un schéma distant et la salle n'a aucun dossier de configuration inscriptible" },
  { cle: "new_task_system_enabled", decision: "couper", valeur: false, motif: "le cockpit lit la liste de tâches native d'opencode ; les outils task_* restent hors du jeu" },
  { cle: "default_run_agent", decision: "couper", valeur: null, motif: "non écrite : l'assistant de la demande est choisi par le cockpit" },
  { cle: "agent_order", decision: "couper", valeur: null, motif: "non écrite : ordre d'affichage de la TUI, absente de la salle" },
  { cle: "agent_definitions", decision: "couper", valeur: [], motif: "aucune définition d'agent lue depuis des fichiers du dépôt" },
  { cle: "disabled_mcps", decision: "garder", valeur: ["codegraph", "context7", "grep_app", "lsp", "websearch"], motif: "les cinq serveurs MCP intégrés sortent sur le réseau ou lancent npm" },
  { cle: "disabled_agents", decision: "garder", valeur: ["librarian", "multimodal-looker"], motif: "JS-3 et spéc. §3.15.1 ; la liste est additive, une couche de projet ne peut pas la vider" },
  {
    cle: "disabled_skills",
    decision: "garder",
    valeur: ["agent-browser", "dev-browser", "git-master", "playwright", "security-research", "security-review", "team-mode", "visual-qa"],
    motif: "compétences qui demandent un navigateur, le réseau, Team Mode ou l'écriture de l'historique git",
  },
  { cle: "disabled_hooks", decision: "garder", valeur: null, motif: "les 23 noms coupés de la table des hooks ; valeur engendrée depuis cette table" },
  { cle: "disabled_commands", decision: "garder", valeur: ["goal", "stop-continuation"], motif: "seules commandes intégrées coupées ; le schéma n'accepte que les six noms connus" },
  { cle: "disabled_tools", decision: "garder", valeur: null, motif: "les noms coupés de la table des outils, sauf « edit » ; valeur engendrée depuis cette table" },
  { cle: "disabled_providers", decision: "garder", valeur: null, motif: "les 25 fournisseurs cités par le paquet, autres que github-copilot" },
  { cle: "mcp_env_allowlist", decision: "couper", valeur: [], motif: "aucune variable d'environnement transmise à un serveur MCP, tous coupés" },
  { cle: "hashline_edit", decision: "couper", valeur: false, motif: "seul levier qui empêche l'éditeur hashline de remplacer l'outil « edit » natif" },
  { cle: "telemetry", decision: "couper", valeur: false, motif: "télémétrie coupée ; l'image pose en plus OMO_DISABLE_POSTHOG=1 et OMO_SEND_ANONYMOUS_TELEMETRY=0" },
  { cle: "model_fallback", decision: "couper", valeur: false, motif: "aucun changement d'IA silencieux : la salle n'utilise que github-copilot/* (JS-11, G3)" },
  {
    cle: "agents",
    decision: "garder",
    valeur: { prometheus: { permission: { edit: "ask", bash: "deny", webfetch: "deny" } } },
    motif: "JS-3 ; les IA de chaque agent sont épinglées sur github-copilot/* par L15a d'après le catalogue du compte (G3)",
  },
  { cle: "categories", decision: "garder", valeur: null, motif: "IA de chaque catégorie épinglées sur github-copilot/* par L15a (G3) ; aucune autre valeur écrite ici" },
  {
    cle: "claude_code",
    decision: "couper",
    valeur: { mcp: false, commands: false, skills: false, agents: false, hooks: false, plugins: false },
    motif: "C2-1 : plus rien n'est lu ni exécuté depuis .claude/ ; l'image pose en plus OPENCODE_DISABLE_CLAUDE_CODE=1",
  },
  { cle: "sisyphus_agent", decision: "garder", valeur: null, motif: "réglages de l'orchestrateur laissés à leurs défauts ; aucun effet hors de la salle" },
  { cle: "comment_checker", decision: "couper", valeur: null, motif: "non écrite : le hook comment-checker est coupé" },
  { cle: "experimental", decision: "garder", valeur: null, motif: "laissée à ses défauts ; max_tools n'est pas écrite, sinon l'élagage retirerait des outils par ordre de priorité" },
  { cle: "auto_update", decision: "couper", valeur: false, motif: "aucune mise à jour de l'extension à l'exécution ; l'image est reconstruite pour changer de version" },
  { cle: "skills", decision: "couper", valeur: null, motif: "non écrite : aucune source de compétences hors du paquet ; .agents/ est refusé au pré-contrôle (D-2b-34)" },
  { cle: "goal", decision: "couper", valeur: { enabled: false, auto_start: false }, motif: "objectif persistant coupé ; c'est aussi ce qui coupe l'ancienne boucle ralph_loop" },
  { cle: "ralph_loop", decision: "couper", valeur: null, motif: "non écrite : alias déprécié de goal, l'écrire rallumerait goal.enabled (migrateRalphLoopConfig)" },
  { cle: "runtime_fallback", decision: "couper", valeur: { enabled: false }, motif: "aucun changement de moteur d'exécution" },
  { cle: "background_task", decision: "garder", valeur: { defaultConcurrency: 2 }, motif: "deux tâches de fond au plus à la fois (§4.8.2)" },
  { cle: "notification", decision: "couper", valeur: { force_enable: false }, motif: "aucune notification hors du cockpit ; le hook session-notification est coupé" },
  { cle: "model_capabilities", decision: "couper", valeur: { enabled: false, auto_refresh_on_start: false }, motif: "le rafraîchissement va chercher un catalogue distant" },
  { cle: "openclaw", decision: "couper", valeur: { enabled: false }, motif: "passerelles vers des services tiers (messagerie, adresses déclarées)" },
  { cle: "i18n", decision: "garder", valeur: null, motif: "langue de la TUI, absente de la salle" },
  { cle: "monitor", decision: "couper", valeur: { enabled: false, live_mode_enabled: false }, motif: "lance des commandes surveillées en arrière-plan ; retire aussi les outils monitor_*" },
  {
    cle: "codegraph",
    decision: "couper",
    valeur: { enabled: false, auto_init: false, auto_provision: false, daemon: false, telemetry: false },
    motif: "quatre défauts à true dans le paquet : indexation, provisionnement et service permanent, avec téléchargement npm",
  },
  { cle: "team_mode", decision: "couper", valeur: { enabled: false, tmux_visualization: false }, motif: "Team Mode coupé (Q5) ; retire aussi les douze outils team_*" },
  { cle: "keyword_detector", decision: "garder", valeur: null, motif: "hook gardé (JS-9) ; aucune restriction de mots-clés écrite" },
  { cle: "babysitting", decision: "garder", valeur: null, motif: "délai de reprise d'une IA muette laissé à son défaut" },
  {
    cle: "git_master",
    decision: "couper",
    valeur: { commit_footer: false, include_co_authored_by: false, git_env_prefix: "" },
    motif: "aucune signature ajoutée : les commits sont faits par vous, l'historique git est en lecture seule (Q2)",
  },
  { cle: "browser_automation_engine", decision: "couper", valeur: null, motif: "non écrite : les compétences de navigateur sont coupées" },
  { cle: "websearch", decision: "couper", valeur: null, motif: "non écrite : le serveur MCP websearch est coupé et la recherche web est refusée" },
  { cle: "tmux", decision: "couper", valeur: { enabled: false }, motif: "aucune fenêtre tmux ; l'outil interactive_bash est coupé avec" },
  { cle: "tui", decision: "garder", valeur: null, motif: "réglages de la TUI, absente de la salle" },
  { cle: "sisyphus", decision: "garder", valeur: null, motif: "chemins de tâches laissés à leurs défauts, sous .omo du projet" },
  { cle: "start_work", decision: "garder", valeur: { auto_commit: false }, motif: "le défaut du paquet est true : un commit automatique échouerait sur un historique git en lecture seule" },
  { cle: "default_mode", decision: "couper", valeur: { ultrawork: false, goal: false }, motif: "aucun mode imposé au démarrage d'une demande" },
  { cle: "_migrations", decision: "couper", valeur: null, motif: "non écrite : marque posée par les migrations de l'extension, impossible sur des dossiers en lecture seule" },
];

// --- Appels réseau connus -----------------------------------------------------------------------------------------------------------

export const RESEAU: readonly OmoFaitReseau[] = [
  {
    quoi: "recherche d'une version plus récente de l'extension",
    hote: "registry.npmjs.org",
    preuve: { fichier: "packages/omo-opencode/src/hooks/auto-update-checker/constants.ts", symbole: "NPM_REGISTRY_URL" },
    fermeturePar: "hook auto-update-checker coupé, auto_update à false, réseau fermé",
  },
  {
    quoi: "installation de la mise à jour trouvée",
    hote: "registre de paquets du gestionnaire",
    preuve: { fichier: "packages/omo-opencode/src/hooks/auto-update-checker/hook/background-update-check.ts", symbole: "runBunInstallSafe" },
    fermeturePar: "hook coupé, /opt/omo en lecture seule, réseau fermé",
  },
  {
    quoi: "rafraîchissement du catalogue des capacités des IA",
    hote: "models.dev",
    preuve: { fichier: "packages/model-core/src/model-capabilities-snapshot.ts", symbole: "MODELS_DEV_SOURCE_URL" },
    fermeturePar: "model_capabilities.enabled et auto_refresh_on_start à false, hook auto-update-checker coupé",
  },
  {
    quoi: "télémétrie d'usage",
    hote: "us.i.posthog.com",
    preuve: { fichier: "packages/telemetry-core/src/constants.ts", symbole: "DEFAULT_POSTHOG_HOST" },
    fermeturePar: "telemetry à false, OMO_DISABLE_POSTHOG=1 et OMO_SEND_ANONYMOUS_TELEMETRY=0, réseau fermé",
  },
  {
    quoi: "téléchargement du binaire ast-grep",
    hote: "github.com (publications ast-grep)",
    preuve: { fichier: "packages/utils/src/ast-grep/sg-manifest.ts", symbole: "SG_PINNED_VERSION" },
    fermeturePar: "hook ast-grep-sg-provision coupé, racine du conteneur en lecture seule, réseau fermé",
  },
  {
    quoi: "téléchargement du binaire codegraph",
    hote: "github.com et registry.npmjs.org (publications codegraph)",
    preuve: { fichier: "packages/utils/src/codegraph/manifest.ts", symbole: "CODEGRAPH_PROVISION_MANIFEST" },
    fermeturePar: "codegraph.enabled et auto_provision à false, MCP codegraph coupé, réseau fermé",
  },
  {
    quoi: "installation automatique de ripgrep par les outils grep et glob",
    hote: "registre de paquets du gestionnaire",
    preuve: { fichier: "packages/omo-opencode/src/shared/ripgrep-cli.ts", symbole: "resolveGrepCliWithAutoInstall" },
    fermeturePar: "outils grep et glob coupés, réseau fermé",
  },
  {
    quoi: "schéma de configuration de l'extension",
    hote: "raw.githubusercontent.com",
    preuve: { fichier: "packages/omo-opencode/src/config-migration/schema-url.ts", symbole: "OMO_SCHEMA_URL" },
    fermeturePar: "aucune configuration écrite : les quatre dossiers de configuration sont en lecture seule (JS-2)",
  },
  {
    quoi: "serveurs MCP distants",
    hote: "services de websearch, context7 et grep_app",
    preuve: { fichier: "packages/omo-opencode/src/mcp/index.ts", symbole: "createBuiltinMcps" },
    fermeturePar: "les cinq MCP sont dans disabled_mcps, réseau fermé",
  },
  {
    quoi: "crochets déclarés par le dépôt (Claude Code)",
    hote: "adresse déclarée dans le dépôt",
    preuve: { fichier: "packages/omo-opencode/src/hooks/claude-code-hooks/execute-http-hook.ts", symbole: "executeHttpHook" },
    fermeturePar: "hook claude-code-hooks coupé, claude_code tout à false, .claude/ refusé au pré-contrôle",
  },
  {
    quoi: "résolution des redirections avant un appel web",
    hote: "adresse demandée par l'outil webfetch",
    preuve: { fichier: "packages/omo-opencode/src/hooks/webfetch-redirect-guard/hook.ts", symbole: "resolveWebFetchRedirects" },
    fermeturePar: "hook coupé, webfetch refusé par la configuration d'instance, réseau fermé",
  },
  {
    quoi: "passerelles OpenClaw",
    hote: "adresses déclarées dans la configuration",
    preuve: { fichier: "packages/omo-opencode/src/config/schema/openclaw.ts", symbole: "OpenClawGatewaySchema" },
    fermeturePar: "openclaw.enabled à false, réseau fermé",
  },
];

// --- Écritures disque connues (F-t, F-u, tui.json) ------------------------------------------------------------------------------------

export const DISQUE: readonly OmoFaitDisque[] = [
  {
    quoi: "renommage du dossier de travail hérité dans le projet, au chargement",
    chemin: "<projet>/.sisyphus → <projet>/.omo",
    preuve: { fichier: "packages/omo-opencode/src/shared/legacy-workspace-migration.ts", symbole: "migrateLegacyWorkspaceDirectory" },
  },
  {
    quoi: "migration des configurations héritées, cherchées du projet jusqu'à la racine",
    chemin: "oh-my-openagent.json[c] et oh-my-opencode.json[c] de chaque dossier",
    preuve: { fichier: "packages/omo-opencode/src/config-migration/discovery-paths.ts", symbole: "CONFIG_FILE_NAMES" },
  },
  {
    quoi: "sauvegardes et journal de migration",
    chemin: "~/.omo/migration-backup-*, ~/.omo/.migration-journal.json, ~/.omo/.migration.lock",
    preuve: { fichier: "packages/omo-config-core/src/migration/journal.ts", symbole: "migrationJournalPath" },
  },
  {
    quoi: "état du travail en cours, plans et carnet partagé",
    chemin: "<projet>/.omo/boulder.json, <projet>/.omo/plans, <projet>/.omo/notepads",
    preuve: { fichier: "packages/boulder-state/src/constants.ts", symbole: "BOULDER_FILE" },
  },
  {
    quoi: "ajout du greffon à la configuration de la TUI",
    chemin: "<dossier de configuration>/tui.json",
    preuve: { fichier: "packages/omo-opencode/src/cli/config-manager/add-tui-plugin-to-tui-config.ts", symbole: "ensureTuiPluginEntry" },
  },
  {
    quoi: "installation du binaire codegraph et de son index",
    chemin: "~/.omo/codegraph",
    preuve: { fichier: "packages/utils/src/codegraph/paths.ts", symbole: "codegraphDataRoot" },
  },
  {
    quoi: "service LSP",
    chemin: "~/.omo/lsp-daemon",
    preuve: { fichier: "packages/utils/src/process-sweep/lsp-daemon-family.ts", symbole: "resolveLspDaemonBaseDir" },
  },
  {
    quoi: "équipes de Team Mode",
    chemin: "<projet>/.omo/teams",
    preuve: { fichier: "packages/team-core/src/team-registry/paths.ts", symbole: "getTeamDirectory" },
  },
  {
    quoi: "état par session des hooks d'injection et de rappel",
    chemin: "fichiers JSON d'état de rules-injector, directory-agents-injector, agent-usage-reminder et interactive-bash-session",
    preuve: { fichier: "packages/omo-opencode/src/hooks/rules-injector/storage.ts", symbole: "RULES_INJECTOR_STORAGE" },
  },
  {
    quoi: "transcription des crochets Claude Code, et un .gitignore posé à côté",
    chemin: "dossier de transcription des crochets",
    preuve: { fichier: "packages/omo-opencode/src/hooks/claude-code-hooks/transcript.ts", symbole: "TRANSCRIPT_DIR" },
  },
  {
    quoi: "cache des capacités des IA",
    chemin: "model-capabilities.json du dossier d'état",
    preuve: { fichier: "packages/omo-opencode/src/shared/model-capabilities-cache.ts", symbole: "MODEL_CAPABILITIES_CACHE_FILE" },
  },
  {
    quoi: "état de la télémétrie",
    chemin: "posthog-activity.json du dossier d'état",
    preuve: { fichier: "packages/telemetry-core/src/activity-state.ts", symbole: "POSTHOG_ACTIVITY_STATE_FILE" },
  },
];

// --- Énumérations et valeurs épinglées : doit être égal à docker/opencode-omo/enums-4.19.4.json ---------------------------------------

export interface OmoEnumerations {
  version: string;
  hooks: readonly string[];
  hooksCoupes: readonly string[];
  outils: readonly string[];
  outilsCoupes: readonly string[];
  mcps: readonly string[];
  mcpsCoupes: readonly string[];
  competences: readonly string[];
  competencesCoupees: readonly string[];
  commandes: readonly string[];
  commandesCoupees: readonly string[];
  agents: readonly string[];
  agentsCoupes: readonly string[];
  cles: readonly string[];
  fournisseursCoupes: readonly string[];
  valeurs: Readonly<Record<string, unknown>>;
}

const noms = <T extends { nom: string }>(entrees: readonly T[]) => entrees.map((e) => e.nom);
const nomsCoupes = <T extends { nom: string; decision: OmoDecision }>(entrees: readonly T[]) => entrees.filter((e) => e.decision === "couper").map((e) => e.nom);

/** Valeurs épinglées de `omo.jsonc`, clé par clé : ce que L15a écrit et ce que le validateur de l'image exige (G14). */
export function valeursEpinglees(): Record<string, unknown> {
  const valeurs: Record<string, unknown> = {};
  for (const entree of CLES) {
    if (entree.cle === "disabled_hooks") valeurs[entree.cle] = nomsCoupes(HOOKS);
    else if (entree.cle === "disabled_tools") valeurs[entree.cle] = [...OUTILS_A_COUPER];
    else if (entree.cle === "disabled_providers") valeurs[entree.cle] = [...FOURNISSEURS_COUPES];
    else if (entree.valeur !== null) valeurs[entree.cle] = entree.valeur;
  }
  return valeurs;
}

export function enumerations(): OmoEnumerations {
  return {
    version: OMO_VERSION,
    hooks: noms(HOOKS),
    hooksCoupes: nomsCoupes(HOOKS),
    outils: noms(OUTILS),
    outilsCoupes: [...OUTILS_A_COUPER],
    mcps: noms(MCPS),
    mcpsCoupes: nomsCoupes(MCPS),
    competences: noms(COMPETENCES),
    competencesCoupees: nomsCoupes(COMPETENCES),
    commandes: noms(COMMANDES),
    commandesCoupees: nomsCoupes(COMMANDES),
    agents: AGENTS.map((a) => a.cle),
    agentsCoupes: AGENTS.filter((a) => a.decision === "couper").map((a) => a.cle),
    cles: CLES.map((c) => c.cle),
    fournisseursCoupes: [...FOURNISSEURS_COUPES],
    valeurs: valeursEpinglees(),
  };
}

// --- Porte G12 : GET /agent comparé à la table --------------------------------------------------------------------------------------

export type OmoEcartAgent =
  | { type: "agent-inconnu"; agent: string }
  | { type: "agent-coupe-present"; agent: string }
  | { type: "agent-absent"; agent: string }
  | { type: "autorisation-non-auditee"; agent: string; permission: string; pattern: string };

export interface CompareAgentsOptions {
  table?: readonly OmoAgentAudit[];
  /** true : un agent gardé absent de `GET /agent` est un écart. Laissé à false hors du banc, où l'image réelle est lue (L21). */
  exigerPresence?: boolean;
}

const autorisee = (entree: OmoAgentAudit, regle: Rule, permission: string): boolean =>
  entree.autorisations.some((a) => a.permission === permission && (a.pattern === regle.pattern || a.pattern === "*"));

/**
 * Écarts entre les agents rendus par `GET /agent` et la table d'audit versionnée (G12). Un `allow` sur une permission sensible
 * qui n'est pas inscrit dans `autorisations` est un écart ; une règle dont la permission est le joker « * » vaut pour chacune.
 */
export function compareAgentsToAudit(agents: readonly AgentLite[], options: CompareAgentsOptions = {}): OmoEcartAgent[] {
  const table = options.table ?? AGENTS;
  const parCle = new Map(table.map((entree) => [entree.cle.toLowerCase(), entree]));
  const ecarts: OmoEcartAgent[] = [];
  const vus = new Set<string>();
  for (const agent of agents) {
    const cle = typeof agent.name === "string" ? agent.name.toLowerCase() : "";
    const entree = parCle.get(cle);
    if (entree === undefined) {
      ecarts.push({ type: "agent-inconnu", agent: agent.name });
      continue;
    }
    vus.add(cle);
    if (entree.decision === "couper") {
      ecarts.push({ type: "agent-coupe-present", agent: agent.name });
      continue;
    }
    for (const regle of agent.permission ?? []) {
      if (regle.action !== "allow") continue;
      const visees = regle.permission === "*" ? PERMISSIONS_SENSIBLES : PERMISSIONS_SENSIBLES.filter((p) => p === regle.permission);
      for (const permission of visees) {
        if (!autorisee(entree, regle, permission)) ecarts.push({ type: "autorisation-non-auditee", agent: agent.name, permission, pattern: regle.pattern });
      }
    }
  }
  if (options.exigerPresence === true) {
    for (const entree of table) {
      if (entree.decision === "garder" && !vus.has(entree.cle.toLowerCase())) ecarts.push({ type: "agent-absent", agent: entree.cle });
    }
  }
  return ecarts;
}
