# Audit d'Oh My OpenAgent 4.19.4 (Salle OMO)

Version auditée : **4.19.4**, paquet npm `oh-my-openagent`. Cet audit est la source des listes `disabled_*` et des valeurs
épinglées d'`omo.jsonc`, de la porte G12 (`GET /agent` comparé à la table) et du tableau « Ce que l'extension fait sans demande »
affiché à l'activation d'une salle.

**Ce document ne cite que des noms, des chemins et des symboles.** Aucun extrait de code ni de consigne de l'extension n'y figure,
ni dans les fixtures du dépôt : le paquet est publié sous licence SUL-1.0 et ce dépôt est public (D-2b-31).

**Source unique** : le paquet npm 4.19.4 déjà extrait, lu sans rien exécuter ni installer (`dist/`, `dist/config/schema/*.d.ts`,
`dist/index.js`, `package.json`). Le dépôt de développement de l'extension n'est jamais utilisé comme source.

**Table machine jumelle** : `app/server/shared/omo-audit-4.19.4.ts`. Les énumérations et les valeurs épinglées en sont extraites
vers `docker/opencode-omo/enums-4.19.4.json`. Le test `app/server/omo-audit.test.ts` vérifie que ce document, la table et ce
fichier JSON portent les mêmes noms et les mêmes décisions.

## 1. Règle de décision

- **couper** : la fonction est mise hors service par une valeur épinglée, ou la clé reste absente parce que l'écrire l'ouvrirait.
- **garder** : la fonction reste en service (clé écrite pour la borner, ou laissée à son défaut sans danger).

Est coupé tout ce qui, dans la salle : sort sur le réseau ; lance ou installe un programme ; injecte d'office dans une consigne du
contenu d'un dépôt non fiable ; écrit hors du projet et de `.omo` ; dépend d'une fonction déjà coupée (Team Mode, tmux, monitor,
OpenClaw, objectif persistant, codegraph, Claude Code, éditeur hashline, commandes interactives, mise à jour) ; ou change d'IA sans
le dire. Est gardé le reste : ce qui met en forme, tronque, vérifie, ou relance la liste de tâches — le principe même du mode.

## 2. Quatre faits de forme, à connaître avant de lire les tables

1. **Aucun joker dans les listes `disabled_*`.** Les noms sont comparés par égalité sur un ensemble
   (`plugin/tool-registry.ts`, `filterDisabledTools`). Écrire `session_*` ou `team_*` ne veut rien dire : chaque nom est écrit en
   entier.
2. **Un nom faux est ignoré en silence.** Au schéma, ces listes sont des tableaux de chaînes libres
   (`config/schema/oh-my-opencode-config.ts`) : ni refus, ni message. D'où le validateur de noms de l'image (porte G14).
3. **Les listes `disabled_*` sont additives** (`plugin-config/config-merger.ts`, `mergeConfigs`) : une couche de projet ne peut pas
   les vider, mais elle peut assouplir `agents.*`. D'où le pré-contrôle du dépôt et de ses parents.
4. **`ralph-loop` n'est pas un nom de hook en 4.19.4.** `HookNameSchema` ne le contient pas ; l'écrire dans `disabled_hooks` serait
   ignoré en silence. La boucle est devenue un alias déprécié de `goal` (`config/validate.ts`, `migrateRalphLoopConfig`) : elle se
   coupe par `goal.enabled: false`, par le hook `goal` dans `disabled_hooks`, et en n'écrivant pas la clé `ralph_loop`.

### Trois pièges de nom relevés dans le paquet

- L'éditeur « hashline » s'enregistre sous le nom **`edit`** et remplace l'outil natif
  (`plugin/tool-registry-gated-tools.ts`, `createHashlineToolsRecord`). Écrire « hashline_edit » dans `disabled_tools` n'aurait
  aucun effet : le seul levier est la clé `hashline_edit: false`.
- La délégation de l'extension s'enregistre sous le nom **`task`** et remplace le `task` natif d'opencode
  (`plugin/tool-registry-core-tools.ts`, `createCoreTools`).
- **`start_work.auto_commit` vaut `true` par défaut** (`config/schema/start-work.ts`) : il est épinglé à `false`, l'historique git
  étant monté en lecture seule. De même, `codegraph` a quatre défauts à `true` : `enabled`, `auto_init`, `auto_provision` et
  `daemon`.

## 3. Outils enregistrés par l'extension

Deux outils, et deux seulement, demandent une autorisation avant d'agir (`ctx.ask`) : `skill` et `monitor_start`. Le paquet ne
contient aucun autre appel de `ctx.ask`. Tous les autres outils agissent **sans demande**.

La colonne « condition » dit à quoi tient l'enregistrement de l'outil ; « — » veut dire qu'il est toujours là.

<!-- table: outils -->
| Outil | Décision | Sans demande | Condition |
|---|---|---|---|
| `grep` | couper | oui | — |
| `glob` | couper | oui | — |
| `session_list` | couper | oui | — |
| `session_read` | couper | oui | — |
| `session_search` | couper | oui | — |
| `session_info` | couper | oui | — |
| `background_output` | garder | oui | — |
| `background_cancel` | garder | oui | — |
| `call_omo_agent` | garder | oui | — |
| `look_at` | couper | oui | `agent multimodal-looker actif` |
| `task` | garder | oui | — |
| `skill_mcp` | couper | oui | — |
| `skill` | garder | non | — |
| `create_goal` | couper | oui | `goal.enabled` |
| `update_goal` | couper | oui | `goal.enabled` |
| `get_goal` | couper | oui | `goal.enabled` |
| `interactive_bash` | couper | oui | `tmux présent sur le chemin` |
| `team_create` | couper | oui | `team_mode.enabled` |
| `team_delete` | couper | oui | `team_mode.enabled` |
| `team_shutdown_request` | couper | oui | `team_mode.enabled` |
| `team_approve_shutdown` | couper | oui | `team_mode.enabled` |
| `team_reject_shutdown` | couper | oui | `team_mode.enabled` |
| `team_send_message` | couper | oui | `team_mode.enabled` |
| `team_task_create` | couper | oui | `team_mode.enabled` |
| `team_task_list` | couper | oui | `team_mode.enabled` |
| `team_task_update` | couper | oui | `team_mode.enabled` |
| `team_task_get` | couper | oui | `team_mode.enabled` |
| `team_status` | couper | oui | `team_mode.enabled` |
| `team_list` | couper | oui | `team_mode.enabled` |
| `monitor_start` | couper | non | `monitor.enabled` |
| `monitor_stop` | couper | oui | `monitor.enabled` |
| `monitor_list` | couper | oui | `monitor.enabled` |
| `monitor_output` | couper | oui | `monitor.enabled` |
| `task_create` | couper | oui | `new_task_system_enabled` |
| `task_get` | couper | oui | `new_task_system_enabled` |
| `task_list` | couper | oui | `new_task_system_enabled` |
| `task_update` | couper | oui | `new_task_system_enabled` |
| `edit` | couper | oui | `hashline_edit` |

Motifs et preuves :

- `grep` — remplace la recherche native et peut télécharger puis installer ripgrep (resolveGrepCliWithAutoInstall). Preuve :
  `packages/omo-opencode/src/tools/grep/tools.ts`, symbole `createGrepTools`.
- `glob` — même moteur que grep, même installation automatique. Preuve : `packages/omo-opencode/src/tools/glob/tools.ts`, symbole `createGlobTools`.
- `session_list` — lit le stockage des conversations de l'instance, hors du projet et hors de la demande en cours. Preuve :
  `packages/omo-opencode/src/tools/session-manager/tools.ts`, symbole `createSessionManagerTools`.
- `session_read` — lit le contenu d'autres conversations de l'instance. Preuve : `packages/omo-opencode/src/tools/session-manager/tools.ts`, symbole
  `createSessionManagerTools`.
- `session_search` — cherche dans le contenu d'autres conversations de l'instance. Preuve :
  `packages/omo-opencode/src/tools/session-manager/tools.ts`, symbole `createSessionManagerTools`.
- `session_info` — expose les métadonnées d'autres conversations de l'instance. Preuve : `packages/omo-opencode/src/tools/session-manager/tools.ts`,
  symbole `createSessionManagerTools`.
- `background_output` — relève le résultat d'une tâche de fond : le mode en dépend ; aucune action sur le disque ni sur le réseau. Preuve :
  `packages/omo-opencode/src/tools/background-task/create-background-output.ts`, symbole `createBackgroundOutput`.
- `background_cancel` — abandonne une tâche de fond : va dans le sens de l'arrêt. Preuve :
  `packages/omo-opencode/src/tools/background-task/create-background-cancel.ts`, symbole `createBackgroundCancel`.
- `call_omo_agent` — confie du travail à un agent de l'extension : le principe du mode ; compté par les plafonds de sessions et de coût. Preuve :
  `packages/omo-opencode/src/tools/call-omo-agent/tools.ts`, symbole `createCallOmoAgent`.
- `look_at` — envoie des fichiers (PDF, images) à une IA multimodale ; l'agent multimodal-looker est coupé (spéc. §3.15.1). Preuve :
  `packages/omo-opencode/src/tools/look-at/tools.ts`, symbole `createLookAt`.
- `task` — délégation de l'extension, qui remplace le task natif : le principe du mode ; comptée et plafonnée. Preuve :
  `packages/omo-opencode/src/tools/delegate-task/tools.ts`, symbole `createDelegateTask`.
- `skill_mcp` — démarre un serveur déclaré par une compétence, sans demande (D-2b-34). Preuve : `packages/omo-opencode/src/tools/skill-mcp/tools.ts`,
  symbole `createSkillMcpTool`.
- `skill` — charge une compétence intégrée ; seul outil de l'extension, avec monitor_start, à demander une autorisation. Preuve :
  `packages/omo-opencode/src/tools/skill/tools.ts`, symbole `createSkillTool`.
- `create_goal` — objectif persistant : enchaînement hors de la demande ; le hook goal est coupé. Preuve :
  `packages/omo-opencode/src/hooks/goal/tools.ts`, symbole `createGoalTools`.
- `update_goal` — même objectif persistant. Preuve : `packages/omo-opencode/src/hooks/goal/tools.ts`, symbole `createGoalTools`.
- `get_goal` — même objectif persistant. Preuve : `packages/omo-opencode/src/hooks/goal/tools.ts`, symbole `createGoalTools`.
- `interactive_bash` — ouvre une session de commandes interactive hors du garde-fou de commandes du cockpit. Preuve :
  `packages/omo-opencode/src/tools/interactive-bash/tools.ts`, symbole `interactive_bash`.
- `team_create` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_delete` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_shutdown_request` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_approve_shutdown` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_reject_shutdown` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_send_message` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_task_create` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_task_list` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_task_update` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_task_get` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_status` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `team_list` — Team Mode coupé (Q5) : outil retiré en plus du réglage, les listes disabled_* étant additives. Preuve :
  `packages/omo-opencode/src/plugin/tool-registry-team-tools.ts`, symbole `createTeamModeToolsRecord`.
- `monitor_start` — lance une commande surveillée en arrière-plan ; monitor.enabled est épinglé à false. Preuve :
  `packages/omo-opencode/src/tools/monitor/monitor-start.ts`, symbole `createMonitorStart`.
- `monitor_stop` — accompagne monitor_start, coupé. Preuve : `packages/omo-opencode/src/tools/monitor/create-monitor-tools.ts`, symbole
  `createMonitorTools`.
- `monitor_list` — accompagne monitor_start, coupé. Preuve : `packages/omo-opencode/src/tools/monitor/create-monitor-tools.ts`, symbole
  `createMonitorTools`.
- `monitor_output` — accompagne monitor_start, coupé. Preuve : `packages/omo-opencode/src/tools/monitor/create-monitor-tools.ts`, symbole
  `createMonitorTools`.
- `task_create` — second système de tâches ; le cockpit lit la liste de tâches native d'opencode (§5.7.3). Preuve :
  `packages/omo-opencode/src/tools/task/task-create.ts`, symbole `createTaskCreateTool`.
- `task_get` — second système de tâches. Preuve : `packages/omo-opencode/src/tools/task/task-get.ts`, symbole `createTaskGetTool`.
- `task_list` — second système de tâches. Preuve : `packages/omo-opencode/src/tools/task/task-list.ts`, symbole `createTaskList`.
- `task_update` — second système de tâches. Preuve : `packages/omo-opencode/src/tools/task/task-update.ts`, symbole `createTaskUpdateTool`.
- `edit` — l'éditeur hashline remplace l'outil natif sous le nom « edit » ; coupé par hashline_edit à false, jamais par disabled_tools. Preuve :
  `packages/omo-opencode/src/tools/hashline-edit/tools.ts`, symbole `createHashlineEditTool`.

`disabled_tools` reçoit les 32 noms coupés ci-dessus, sauf `edit` : cet outil n'existe que si `hashline_edit` vaut `true`.

## 4. Ce que l'extension fait sans demande

Ce tableau est **engendré** depuis la table machine (`omo-audit-texts.ts`, `tableauSansDemande`) : il ne liste que ce qui reste en
service et agit sans passer par une demande. C'est lui qui est affiché à l'activation d'une salle (§4.10) et dans le Diagnostic.

<!-- table: sans-demande -->
| Nom | Origine | Ce qu'elle fait |
|---|---|---|
| `background_output` | Outil | Relève le résultat d'un travail lancé en arrière-plan. |
| `background_cancel` | Outil | Abandonne un travail lancé en arrière-plan. |
| `call_omo_agent` | Outil | Confie un travail à un autre assistant de l'extension. |
| `task` | Outil | Confie un travail à un autre assistant, en attendant le résultat ou en arrière-plan. |
| `atlas` | Automatisme | Suit le plan et confie les tâches une à une jusqu'au bout. |
| `delegate-task-retry` | Automatisme | Recommence un travail confié qui s'est arrêté en erreur. |
| `keyword-detector` | Automatisme | Complète votre message avant l'envoi quand il contient un mot-clé de l'extension. |
| `preemptive-compaction` | Automatisme | Résume la mémoire de la conversation avant sa limite : ce résumé appelle l'IA et coûte. |
| `sisyphus-junior-notepad` | Automatisme | Écrit des notes dans les fichiers partagés du projet, que les assistants relisent. |
| `start-work` | Automatisme | Ouvre une séance de travail à partir d'un plan. |
| `todo-continuation-enforcer` | Automatisme | Relance la liste de tâches tant qu'elle n'est pas terminée. |
| `unstable-agent-babysitter` | Automatisme | Relance un assistant resté muet. |

## 5. Automatismes (hooks)

`HookNameSchema` (`config/schema/hooks.ts`) énumère **56** noms. Chacun a une décision ci-dessous. La colonne
« sans demande » marque ceux qui agissent d'eux-mêmes, au-delà de la mise en forme d'un texte.

<!-- table: hooks -->
| Automatisme | Décision | Sans demande |
|---|---|---|
| `agent-usage-reminder` | garder | non |
| `anthropic-context-window-limit-recovery` | couper | non |
| `ast-grep-sg-provision` | couper | oui |
| `atlas` | garder | oui |
| `auto-slash-command` | couper | oui |
| `auto-update-checker` | couper | oui |
| `background-notification` | garder | non |
| `bash-file-read-guard` | garder | non |
| `category-skill-reminder` | garder | non |
| `claude-code-hooks` | couper | oui |
| `codegraph-bootstrap` | couper | oui |
| `comment-checker` | couper | oui |
| `compaction-context-injector` | garder | non |
| `compaction-todo-preserver` | garder | non |
| `delegate-task-retry` | garder | oui |
| `directory-agents-injector` | couper | oui |
| `directory-readme-injector` | couper | oui |
| `edit-error-recovery` | garder | non |
| `empty-task-response-detector` | garder | non |
| `fsync-skip-warning` | garder | non |
| `goal` | couper | oui |
| `hashline-read-enhancer` | couper | oui |
| `hephaestus-agents-md-injector` | couper | oui |
| `interactive-bash-session` | couper | oui |
| `json-error-recovery` | garder | non |
| `keyword-detector` | garder | oui |
| `legacy-plugin-toast` | couper | non |
| `model-fallback` | couper | oui |
| `monitor-status-injector` | couper | non |
| `no-hephaestus-non-gpt` | garder | non |
| `no-sisyphus-gpt` | garder | non |
| `non-interactive-env` | couper | oui |
| `notepad-write-guard` | garder | non |
| `plan-format-validator` | garder | non |
| `preemptive-compaction` | garder | oui |
| `prometheus-md-only` | garder | non |
| `question-label-truncator` | garder | non |
| `read-image-resizer` | garder | non |
| `rules-injector` | couper | oui |
| `runtime-fallback` | couper | oui |
| `session-notification` | couper | oui |
| `sisyphus-junior-notepad` | garder | oui |
| `start-work` | garder | oui |
| `startup-toast` | garder | non |
| `stop-continuation-guard` | couper | non |
| `task-resume-info` | garder | non |
| `tasks-todowrite-disabler` | garder | non |
| `team-tool-gating` | couper | non |
| `think-mode` | garder | non |
| `todo-continuation-enforcer` | garder | oui |
| `todo-description-override` | garder | non |
| `tool-output-truncator` | garder | non |
| `tool-pair-validator` | garder | non |
| `unstable-agent-babysitter` | garder | oui |
| `webfetch-redirect-guard` | couper | oui |
| `write-existing-file-guard` | garder | non |

Motifs :

- `agent-usage-reminder` — rappel de texte ajouté à la consigne ; n'agit ni sur le disque du projet ni sur le réseau.
- `anthropic-context-window-limit-recovery` — réécrit des fichiers de messages dans le stockage des sessions et ne vise qu'Anthropic, absent de la
  salle (Copilot seul).
- `ast-grep-sg-provision` — télécharge un binaire ast-grep depuis une publication GitHub et l'écrit sur le disque.
- `atlas` — orchestration du plan : le principe même du mode (JS-9).
- `auto-slash-command` — exécute un raccourci dès qu'un message commence par « / », sans demande.
- `auto-update-checker` — interroge le registre npm et peut lancer une installation ; déclenche aussi le rafraîchissement des capacités des IA.
- `background-notification` — range les avis de tâches de fond dans la consigne suivante ; reste dans la salle.
- `bash-file-read-guard` — garde-fou : détourne la lecture de fichiers par une commande vers l'outil de lecture.
- `category-skill-reminder` — rappel de texte sur les compétences disponibles.
- `claude-code-hooks` — exécute les crochets déclarés par le dépôt (.claude/), y compris des appels vers une adresse déclarée (C2-1).
- `codegraph-bootstrap` — provisionne puis lance le service codegraph, téléchargé depuis le registre npm.
- `comment-checker` — lance un programme et sort sur le réseau.
- `compaction-context-injector` — remet du contexte après un résumé de mémoire ; texte seulement.
- `compaction-todo-preserver` — garde la liste de tâches à travers un résumé de mémoire.
- `delegate-task-retry` — reprend une délégation en échec, sans demande ; borné par les plafonds de la salle (§4.8.2).
- `directory-agents-injector` — JS-9 : ajoute d'office aux consignes des définitions d'agents trouvées dans le dépôt.
- `directory-readme-injector` — ajoute d'office le contenu de fichiers du dépôt après chaque lecture : consigne grossie sans demande, coût non
  maîtrisé.
- `edit-error-recovery` — rattrape une modification en échec ; texte seulement.
- `empty-task-response-detector` — repère une délégation revenue sans réponse.
- `fsync-skip-warning` — avertissement de texte.
- `goal` — objectif persistant et outils create_goal, update_goal, get_goal : enchaînement hors de la demande (spéc. §3.15.1).
- `hashline-read-enhancer` — accompagne l'éditeur hashline, coupé par hashline_edit à false ; lance des programmes.
- `hephaestus-agents-md-injector` — injecte les AGENTS.md du projet et de ses parents : consignes d'autorité venues d'un dépôt non fiable, même
  famille que rules-injector.
- `interactive-bash-session` — suit des sessions de commandes interactives ; l'outil interactive_bash est coupé.
- `json-error-recovery` — rattrape une réponse mal formée ; texte seulement.
- `keyword-detector` — « ulw » et les mots-clés du mode : étend le message avant l'envoi (JS-9).
- `legacy-plugin-toast` — invite à lancer une installation de l'extension.
- `model-fallback` — change d'IA sans le dire ; la salle n'utilise que github-copilot/* (JS-11, G3).
- `monitor-status-injector` — accompagne les outils monitor_*, coupés avec monitor.enabled à false.
- `no-hephaestus-non-gpt` — avis affiché dans la TUI ; aucun effet sur les fichiers ni sur le réseau.
- `no-sisyphus-gpt` — avis affiché dans la TUI ; aucun effet sur les fichiers ni sur le réseau.
- `non-interactive-env` — ajoute des affectations d'environnement aux commandes : le texte classé par le cockpit (§4.5) ne serait plus celui exécuté.
- `notepad-write-guard` — garde-fou d'écriture du carnet partagé.
- `plan-format-validator` — vérifie la forme du plan ; texte seulement.
- `preemptive-compaction` — résume la mémoire avant le plafond de contexte : appel d'IA sans demande, compté par les plafonds.
- `prometheus-md-only` — restreint le planificateur aux fichiers .md : renfort de JS-3.
- `question-label-truncator` — tronque un libellé ; texte seulement.
- `read-image-resizer` — réduit une image lue avant de l'envoyer.
- `rules-injector` — JS-9 : injecte les fichiers de règles du dépôt et du dossier personnel dans les consignes.
- `runtime-fallback` — change de moteur d'exécution sans le dire.
- `session-notification` — lance un programme du système pour notifier hors du cockpit.
- `sisyphus-junior-notepad` — écrit le carnet partagé sous .omo/notepads : montré par la carte (JP-6).
- `start-work` — ouvre une séance de travail depuis un plan (JS-9) ; start_work.auto_commit est épinglé à false.
- `startup-toast` — avis de démarrage dans la TUI.
- `stop-continuation-guard` — frein de la commande stop-continuation, elle-même coupée : l'arrêt de la salle passe par la séquence du cockpit, jamais
  par une commande qui relancerait un tour (JS-1).
- `task-resume-info` — rappelle l'état d'un travail repris ; texte seulement.
- `tasks-todowrite-disabler` — sans effet ici : le système de tâches de l'extension reste coupé.
- `team-tool-gating` — Team Mode coupé (Q5, défaut signalé en amont sur opencode 1.18.30).
- `think-mode` — règle l'effort de réflexion demandé ; texte seulement.
- `todo-continuation-enforcer` — relance la liste de tâches jusqu'au bout : le principe même du mode (JS-9).
- `todo-description-override` — réécrit le libellé d'une tâche ; texte seulement.
- `tool-output-truncator` — tronque une sortie d'outil trop longue.
- `tool-pair-validator` — vérifie l'appariement des appels d'outils ; texte seulement.
- `unstable-agent-babysitter` — relance une IA restée muette, sans demande ; borné par les plafonds de la salle.
- `webfetch-redirect-guard` — suit les redirections avant un appel web ; webfetch est refusé dans la salle.
- `write-existing-file-guard` — garde-fou : refuse d'écraser un fichier existant qui n'a pas été lu.

## 6. Agents

Le rôle est lu sur la **clé de configuration** (`agents.<clé>`), jamais sur le `displayName`, que l'extension et l'utilisateur
peuvent réécrire. Une clé inconnue tombe dans « autres » (`app/server/shared/omo-roles.ts`).

**Permissions attendues (porte G12).** opencode applique la **dernière** règle qui correspond, et chaque agent commence par une
règle qui autorise tout ; viennent ensuite la configuration d'instance, puis la section de l'agent. La porte (`compareAgentsToAudit`)
ne retient donc que les `allow` **encore en vigueur** sur une permission sensible (`edit`, `bash`, `task`, `webfetch`, `websearch`, `external_directory`, `read`)
et les compare aux autorisations auditées : celles de la colonne ci-dessous, plus les autorisations communes d'opencode. Elle sonde
en plus des fichiers de clés, en lecture et en modification : aucun ne doit être autorisé. Un agent inconnu, un agent coupé
toujours présent et, sur le banc, un agent attendu absent sont aussi des écarts.

Le cas qui a motivé la porte : `prometheus` porte, dans le paquet, `edit`, `bash`, `webfetch` et `question` à `allow`
(`agents/prometheus/system-prompt.ts`, symbole `PROMETHEUS_PERMISSION`). Le réglage `agents.prometheus.permission` remplace cette
permission en entier par `edit: ask`, `bash: deny`, `webfetch: deny` (JS-3).

<!-- table: agents -->
| Clé de configuration | Décision | Rôle | Attendu dans `GET /agent` | Autorisations `allow` propres |
|---|---|---|---|---|
| `build` | garder | executer | oui | aucune |
| `plan` | garder | planifier | oui | aucune |
| `sisyphus` | garder | planifier | oui | `task *` |
| `hephaestus` | garder | executer | oui | `task *` |
| `sisyphus-junior` | garder | executer | oui | aucune |
| `OpenCode-Builder` | garder | executer | non | aucune |
| `prometheus` | garder | planifier | oui | `task *` |
| `metis` | garder | conseiller | oui | aucune |
| `momus` | garder | verifier | oui | aucune |
| `oracle` | garder | conseiller | oui | aucune |
| `librarian` | couper | chercher | non | aucune |
| `explore` | garder | chercher | oui | aucune |
| `multimodal-looker` | couper | chercher | non | aucune |
| `atlas` | garder | planifier | oui | `task *` |

Motifs :

- `build` — agent natif d'opencode, rendu caché par l'extension ; edit et bash à « ask » par la configuration d'instance, task refusé au niveau
  global.
- `plan` — agent natif d'opencode, en lecture et plan ; ses droits viennent de la configuration d'instance.
- `sisyphus` — orchestrateur du mode : planifie, confie, relance ; l'extension lui accorde task, le principe même du mode.
- `hephaestus` — exécutant autonome ; l'extension lui accorde task ; aucune autre autorisation après la configuration d'instance.
- `sisyphus-junior` — exécutant sans délégation : task reste refusé au niveau global.
- `OpenCode-Builder` — créé seulement si sisyphus_agent.default_builder_enabled vaut true, laissé à false : absent de GET /agent ; s'il apparaît,
  mêmes droits que build.
- `prometheus` — planificateur ; agents.prometheus.permission remplace les trois « allow » du paquet par edit « ask », bash « deny », webfetch « deny
  » (JS-3) ; l'extension lui accorde task.
- `metis` — conseil avant le plan ; lecture seule, task refusé par l'extension.
- `momus` — relecture de plan ; lecture seule, task refusé par l'extension.
- `oracle` — conseil sur les points durs ; lecture seule, task refusé par l'extension.
- `librarian` — cherche dans des dépôts distants et récupère de la documentation : sortie réseau (spéc. §3.15.1).
- `explore` — recherche dans le projet ouvert ; task refusé par l'extension.
- `multimodal-looker` — envoie des fichiers à une IA multimodale ; retire aussi l'outil look_at du registre (spéc. §3.15.1).
- `atlas` — orchestration du plan (JS-9) ; l'extension lui accorde task.

**Agents natifs d'opencode.** `GET /agent` rend aussi les agents natifs d'opencode 1.18.30, cachés compris, qu'aucune clé
`agents.*` de l'extension ne nomme. Ils sont connus de la porte G12 mais restent hors des énumérations ; leur rôle est « autres ».

<!-- table: agents-opencode -->
| Agent | Décision | Rôle | Attendu dans `GET /agent` | Autorisations `allow` propres |
|---|---|---|---|---|
| `general` | garder | autres | oui | aucune |
| `compaction` | garder | autres | oui | aucune |
| `title` | garder | autres | oui | aucune |
| `summary` | garder | autres | oui | aucune |

Motifs :

- `general` — sous-agent généraliste d'opencode ; ses droits viennent de la configuration d'instance, task refusé au niveau global.
- `compaction` — agent caché d'opencode qui résume la mémoire d'une conversation ; aucune autorisation propre au-delà de la configuration d'instance.
- `title` — agent caché d'opencode qui donne un titre à une conversation ; aucune autorisation propre au-delà de la configuration d'instance.
- `summary` — agent caché d'opencode qui résume une conversation ; aucune autorisation propre au-delà de la configuration d'instance.

**Autorisations communes.** opencode les pose sur tout agent, quelle que soit la configuration ; elles sont acceptées pour chacun.

<!-- table: autorisations-communes -->
| Permission | Motif de chemin |
|---|---|
| `read` | `*` |
| `external_directory` | `/home/node/.local/share/opencode/tool-output/*` |

Motifs :

- `read` — lecture sans demande, règle par défaut d'opencode ; les fichiers de clés et .env* restent refusés, vérifié par les sondes.
- `external_directory` — sorties d'outils tronquées d'opencode, réautorisées après toute configuration ; chemin de l'utilisateur node, à confirmer par
  T-L20-b.

**Fichiers de clés sondés** (`read` et `edit`) : la configuration d'instance les refuse, aucune
section d'agent ne doit les rouvrir :

- `/workspace/projet/.env`, `/workspace/projet/app/.env.production`, `/workspace/projet/certs/serveur.key`, `/workspace/projet/certs/serveur.pfx`,
  `/workspace/projet/.ssh/id_ed25519`

**Permissions posées par l'extension elle-même.** Le module de configuration des outils passe après les réglages `agents.*` : ce
qu'il écrit l'emporte sur eux, et aucune clé d'`omo.jsonc` ne le reprend.

<!-- table: permissions-posees -->
| Ce que pose l'extension |
|---|
| webfetch et external_directory à « allow », placés devant la configuration d'instance |
| task forcé à « deny » au niveau global, après la configuration d'instance |
| task à « allow » pour atlas, sisyphus, hephaestus et prometheus |
| task à « deny » pour librarian, explore, oracle, multimodal-looker, metis et momus |
| question, teammate et task_* à « allow », call_omo_agent à « deny », selon l'agent : orchestrateurs et sisyphus-junior |
| réglage agents.prometheus fusionné clé par clé au premier niveau : sa permission remplace celle du paquet en entier |

Conséquences et preuves :

- webfetch et external_directory à « allow », placés devant la configuration d'instance — la configuration d'instance doit écrire les deux à « deny »
  : une clé oubliée resterait ouverte par l'extension. Preuve : `packages/omo-opencode/src/plugin-handlers/tool-config-handler.ts`, symbole
  `applyToolConfig`.
- task forcé à « deny » au niveau global, après la configuration d'instance — le « ask » d'instance sur task ne s'applique jamais : un agent délègue
  seulement si l'extension lui accorde task, et sa délégation ne demande pas. Preuve :
  `packages/omo-opencode/src/plugin-handlers/tool-config-handler.ts`, symbole `applyToolConfig`.
- task à « allow » pour atlas, sisyphus, hephaestus et prometheus — aucune clé d'omo.jsonc ne le retire ; autorisation auditée dans la table des
  agents. Preuve : `packages/omo-opencode/src/plugin-handlers/tool-config-handler.ts`, symbole `applyToolConfig`.
- task à « deny » pour librarian, explore, oracle, multimodal-looker, metis et momus — ces agents ne délèguent pas. Preuve :
  `packages/omo-opencode/src/plugin-handlers/tool-config-handler.ts`, symbole `TASK_DENIED_SUBAGENT_KEYS`.
- question, teammate et task_* à « allow », call_omo_agent à « deny », selon l'agent : orchestrateurs et sisyphus-junior — hors des permissions
  sensibles : teammate et task_* désignent des outils coupés (Team Mode, second système de tâches). Preuve :
  `packages/omo-opencode/src/plugin-handlers/tool-config-handler.ts`, symbole `applyToolConfig`.
- réglage agents.prometheus fusionné clé par clé au premier niveau : sa permission remplace celle du paquet en entier — les trois « allow » de
  PROMETHEUS_PERMISSION disparaissent ; applyToolConfig ajoute ensuite bash et interactive_bash à « deny ». Preuve :
  `packages/omo-opencode/src/plugin-handlers/prometheus-agent-config-builder.ts`, symbole `buildPrometheusAgentConfig`.

## 7. Serveurs MCP intégrés

`McpNameSchema` (`mcp/types.ts`) énumère cinq serveurs. Tous sont coupés.

<!-- table: mcps -->
| Serveur | Décision |
|---|---|
| `codegraph` | couper |
| `context7` | couper |
| `grep_app` | couper |
| `lsp` | couper |
| `websearch` | couper |

Motifs et preuves :

- `codegraph` — service local dont le binaire est téléchargé depuis le registre npm et installé sous ~/.omo/codegraph. Preuve :
  `packages/utils/src/codegraph/provision.ts`, symbole `ensureCodegraphProvisioned`.
- `context7` — serveur distant : sortie réseau vers un service tiers. Preuve : `packages/omo-opencode/src/mcp/context7.ts`, symbole
  `createContext7Config`.
- `grep_app` — serveur distant : sortie réseau vers un service tiers. Preuve : `packages/omo-opencode/src/mcp/grep-app.ts`, symbole `grep_app`.
- `lsp` — serveur local dont l'amorçage lance npm ou bun quand le binaire n'est pas déjà là. Preuve : `packages/omo-opencode/src/mcp/lsp.ts`, symbole
  `createBootstrapCandidate`.
- `websearch` — serveur distant : recherche web, refusée dans la salle. Preuve : `packages/omo-opencode/src/mcp/websearch.ts`, symbole
  `createWebsearchConfig`.

## 8. Compétences intégrées

`BuiltinSkillNameSchema` (`config/schema/agent-names.ts`) énumère treize noms. La compétence de navigateur réellement chargée
dépend de `browser_automation_engine.provider` (`skills-loader-core`, symbole `createBuiltinSkills`) ; les trois noms sont coupés.

<!-- table: competences -->
| Compétence | Décision |
|---|---|
| `agent-browser` | couper |
| `debugging` | garder |
| `dev-browser` | couper |
| `frontend` | garder |
| `git-master` | couper |
| `init-deep` | garder |
| `playwright` | couper |
| `remove-ai-slops` | garder |
| `review-work` | garder |
| `security-research` | couper |
| `security-review` | couper |
| `team-mode` | couper |
| `visual-qa` | couper |

Motifs :

- `agent-browser` — pilote un navigateur par un programme externe, à installer : réseau fermé dans la salle.
- `debugging` — méthode de recherche de panne ; texte seulement.
- `dev-browser` — pilote un navigateur persistant : réseau fermé dans la salle.
- `frontend` — méthode de travail sur l'interface ; texte seulement.
- `git-master` — l'historique git est monté en lecture seule (Q2) et l'envoi git est un interdit absolu : la compétence ne peut pas aboutir.
- `init-deep` — écrit des AGENTS.md dans le projet, écriture permise et visible ; aucun réseau.
- `playwright` — pilote un navigateur, installé à la demande : réseau fermé dans la salle.
- `remove-ai-slops` — nettoyage de code par délégations, déjà plafonnées.
- `review-work` — relecture par délégations, déjà plafonnées.
- `security-research` — s'appuie sur Team Mode, coupé (Q5).
- `security-review` — alias de security-research, qui s'appuie sur Team Mode.
- `team-mode` — Team Mode coupé (Q5).
- `visual-qa` — s'appuie sur le pilotage d'un navigateur, coupé.

## 9. Commandes intégrées

`BuiltinCommandNameSchema` (`config/schema/commands.ts`) énumère six noms.

<!-- table: commandes -->
| Commande | Décision |
|---|---|
| `goal` | couper |
| `hyperplan` | garder |
| `refactor` | garder |
| `remove-ai-slops` | garder |
| `start-work` | garder |
| `stop-continuation` | couper |

Motifs :

- `goal` — objectif persistant : enchaînement hors de la demande.
- `hyperplan` — plan détaillé ; reste dans la demande.
- `refactor` — travail sur le code du projet, déjà borné par les interdits et les plafonds.
- `remove-ai-slops` — nettoyage de code ; délégations plafonnées.
- `start-work` — ouverture d'une séance depuis un plan (JS-9) ; auto_commit épinglé à false.
- `stop-continuation` — relancerait un tour facturé ; l'arrêt de la salle passe par la séquence du cockpit (JS-1).

## 10. Clés de configuration de premier niveau

`OhMyOpenCodeConfigSchema` (`config/schema/oh-my-opencode-config.ts`) porte **46** clés de premier niveau. Chacune a une
décision. « valeur » est ce qu'`omo.jsonc` écrit ; « — » veut dire que la clé reste absente.

<!-- table: cles -->
| Clé | Décision | Valeur épinglée |
|---|---|---|
| `$schema` | couper | — |
| `new_task_system_enabled` | couper | `false` |
| `default_run_agent` | couper | — |
| `agent_order` | couper | — |
| `agent_definitions` | couper | `[]` |
| `disabled_mcps` | garder | `["codegraph","context7","grep_app","lsp","websearch"]` |
| `disabled_agents` | garder | `["librarian","multimodal-looker"]` |
| `disabled_skills` | garder | `["agent-browser","dev-browser","git-master","playwright","security-research","security-review","team-mode","visual-qa"]` |
| `disabled_hooks` | garder | — |
| `disabled_commands` | garder | `["goal","stop-continuation"]` |
| `disabled_tools` | garder | — |
| `disabled_providers` | garder | — |
| `mcp_env_allowlist` | couper | `[]` |
| `hashline_edit` | couper | `false` |
| `telemetry` | couper | `false` |
| `model_fallback` | couper | `false` |
| `agents` | garder | `{"prometheus":{"permission":{"edit":"ask","bash":"deny","webfetch":"deny"}}}` |
| `categories` | garder | — |
| `claude_code` | couper | `{"mcp":false,"commands":false,"skills":false,"agents":false,"hooks":false,"plugins":false}` |
| `sisyphus_agent` | garder | — |
| `comment_checker` | couper | — |
| `experimental` | garder | — |
| `auto_update` | couper | `false` |
| `skills` | couper | — |
| `goal` | couper | `{"enabled":false,"auto_start":false}` |
| `ralph_loop` | couper | — |
| `runtime_fallback` | couper | `{"enabled":false}` |
| `background_task` | garder | `{"defaultConcurrency":2}` |
| `notification` | couper | `{"force_enable":false}` |
| `model_capabilities` | couper | `{"enabled":false,"auto_refresh_on_start":false}` |
| `openclaw` | couper | `{"enabled":false}` |
| `i18n` | garder | — |
| `monitor` | couper | `{"enabled":false,"live_mode_enabled":false}` |
| `codegraph` | couper | `{"enabled":false,"auto_init":false,"auto_provision":false,"daemon":false,"telemetry":false}` |
| `team_mode` | couper | `{"enabled":false,"tmux_visualization":false}` |
| `keyword_detector` | garder | — |
| `babysitting` | garder | — |
| `git_master` | couper | `{"commit_footer":false,"include_co_authored_by":false,"git_env_prefix":""}` |
| `browser_automation_engine` | couper | — |
| `websearch` | couper | — |
| `tmux` | couper | `{"enabled":false}` |
| `tui` | garder | — |
| `sisyphus` | garder | — |
| `start_work` | garder | `{"auto_commit":false}` |
| `default_mode` | couper | `{"ultrawork":false,"goal":false}` |
| `_migrations` | couper | — |

Motifs :

- `$schema` — non écrite : elle désigne un schéma distant et la salle n'a aucun dossier de configuration inscriptible.
- `new_task_system_enabled` — le cockpit lit la liste de tâches native d'opencode ; les outils task_* restent hors du jeu.
- `default_run_agent` — non écrite : l'assistant de la demande est choisi par le cockpit.
- `agent_order` — non écrite : ordre d'affichage de la TUI, absente de la salle.
- `agent_definitions` — aucune définition d'agent lue depuis des fichiers du dépôt.
- `disabled_mcps` — les cinq serveurs MCP intégrés sortent sur le réseau ou lancent npm.
- `disabled_agents` — JS-3 et spéc. §3.15.1 ; la liste est additive, une couche de projet ne peut pas la vider.
- `disabled_skills` — compétences qui demandent un navigateur, le réseau, Team Mode ou l'écriture de l'historique git.
- `disabled_hooks` — les 23 noms coupés de la table des hooks ; valeur engendrée depuis cette table.
- `disabled_commands` — seules commandes intégrées coupées ; le schéma n'accepte que les six noms connus.
- `disabled_tools` — les noms coupés de la table des outils, sauf « edit » ; valeur engendrée depuis cette table.
- `disabled_providers` — les 25 fournisseurs cités par le paquet, autres que github-copilot.
- `mcp_env_allowlist` — aucune variable d'environnement transmise à un serveur MCP, tous coupés.
- `hashline_edit` — seul levier qui empêche l'éditeur hashline de remplacer l'outil « edit » natif.
- `telemetry` — télémétrie coupée ; l'image pose en plus OMO_DISABLE_POSTHOG=1 et OMO_SEND_ANONYMOUS_TELEMETRY=0.
- `model_fallback` — aucun changement d'IA silencieux : la salle n'utilise que github-copilot/* (JS-11, G3).
- `agents` — JS-3 ; les IA de chaque agent sont épinglées sur github-copilot/* par L15a d'après le catalogue du compte (G3).
- `categories` — IA de chaque catégorie épinglées sur github-copilot/* par L15a (G3) ; aucune autre valeur écrite ici.
- `claude_code` — C2-1 : plus rien n'est lu ni exécuté depuis .claude/ ; l'image pose en plus OPENCODE_DISABLE_CLAUDE_CODE=1.
- `sisyphus_agent` — réglages de l'orchestrateur laissés à leurs défauts ; aucun effet hors de la salle.
- `comment_checker` — non écrite : le hook comment-checker est coupé.
- `experimental` — laissée à ses défauts ; max_tools n'est pas écrite, sinon l'élagage retirerait des outils par ordre de priorité.
- `auto_update` — aucune mise à jour de l'extension à l'exécution ; l'image est reconstruite pour changer de version.
- `skills` — non écrite : aucune source de compétences hors du paquet ; .agents/ est refusé au pré-contrôle (D-2b-34).
- `goal` — objectif persistant coupé ; c'est aussi ce qui coupe l'ancienne boucle ralph_loop.
- `ralph_loop` — non écrite : alias déprécié de goal, l'écrire rallumerait goal.enabled (migrateRalphLoopConfig).
- `runtime_fallback` — aucun changement de moteur d'exécution.
- `background_task` — deux tâches de fond au plus à la fois (§4.8.2).
- `notification` — aucune notification hors du cockpit ; le hook session-notification est coupé.
- `model_capabilities` — le rafraîchissement va chercher un catalogue distant.
- `openclaw` — passerelles vers des services tiers (messagerie, adresses déclarées).
- `i18n` — langue de la TUI, absente de la salle.
- `monitor` — lance des commandes surveillées en arrière-plan ; retire aussi les outils monitor_*.
- `codegraph` — quatre défauts à true dans le paquet : indexation, provisionnement et service permanent, avec téléchargement npm.
- `team_mode` — Team Mode coupé (Q5) ; retire aussi les douze outils team_*.
- `keyword_detector` — hook gardé (JS-9) ; aucune restriction de mots-clés écrite.
- `babysitting` — délai de reprise d'une IA muette laissé à son défaut.
- `git_master` — aucune signature ajoutée : les commits sont faits par vous, l'historique git est en lecture seule (Q2).
- `browser_automation_engine` — non écrite : les compétences de navigateur sont coupées.
- `websearch` — non écrite : le serveur MCP websearch est coupé et la recherche web est refusée.
- `tmux` — aucune fenêtre tmux ; l'outil interactive_bash est coupé avec.
- `tui` — réglages de la TUI, absente de la salle.
- `sisyphus` — chemins de tâches laissés à leurs défauts, sous .omo du projet.
- `start_work` — le défaut du paquet est true : un commit automatique échouerait sur un historique git en lecture seule.
- `default_mode` — aucun mode imposé au démarrage d'une demande.
- `_migrations` — non écrite : marque posée par les migrations de l'extension, impossible sur des dossiers en lecture seule.

Trois listes sont engendrées depuis les tables ci-dessus et trop longues pour être répétées ici :
`disabled_hooks` (23 noms), `disabled_tools` (32 noms) et `disabled_providers`
(25 noms). Le fichier `docker/opencode-omo/enums-4.19.4.json` en porte le contenu exact.

## 11. Appels réseau connus

<!-- table: reseau -->
| Appel | Hôte |
|---|---|
| recherche d'une version plus récente de l'extension | registry.npmjs.org |
| installation de la mise à jour trouvée | registre de paquets du gestionnaire |
| rafraîchissement du catalogue des capacités des IA | models.dev |
| télémétrie d'usage | us.i.posthog.com |
| téléchargement du binaire ast-grep | github.com (publications ast-grep) |
| téléchargement du binaire codegraph | github.com et registry.npmjs.org (publications codegraph) |
| installation automatique de ripgrep par les outils grep et glob | registre de paquets du gestionnaire |
| schéma de configuration de l'extension | raw.githubusercontent.com |
| serveurs MCP distants | services de websearch, context7 et grep_app |
| crochets déclarés par le dépôt (Claude Code) | adresse déclarée dans le dépôt |
| résolution des redirections avant un appel web | adresse demandée par l'outil webfetch |
| passerelles OpenClaw | adresses déclarées dans la configuration |

Preuves et fermeture :

- recherche d'une version plus récente de l'extension — preuve : `packages/omo-opencode/src/hooks/auto-update-checker/constants.ts`, symbole
  `NPM_REGISTRY_URL` ; fermé par : hook auto-update-checker coupé, auto_update à false, réseau fermé.
- installation de la mise à jour trouvée — preuve : `packages/omo-opencode/src/hooks/auto-update-checker/hook/background-update-check.ts`, symbole
  `runBunInstallSafe` ; fermé par : hook coupé, /opt/omo en lecture seule, réseau fermé.
- rafraîchissement du catalogue des capacités des IA — preuve : `packages/model-core/src/model-capabilities-snapshot.ts`, symbole
  `MODELS_DEV_SOURCE_URL` ; fermé par : model_capabilities.enabled et auto_refresh_on_start à false, hook auto-update-checker coupé.
- télémétrie d'usage — preuve : `packages/telemetry-core/src/constants.ts`, symbole `DEFAULT_POSTHOG_HOST` ; fermé par : telemetry à false,
  OMO_DISABLE_POSTHOG=1 et OMO_SEND_ANONYMOUS_TELEMETRY=0, réseau fermé.
- téléchargement du binaire ast-grep — preuve : `packages/utils/src/ast-grep/sg-manifest.ts`, symbole `SG_PINNED_VERSION` ; fermé par : hook
  ast-grep-sg-provision coupé, racine du conteneur en lecture seule, réseau fermé.
- téléchargement du binaire codegraph — preuve : `packages/utils/src/codegraph/manifest.ts`, symbole `CODEGRAPH_PROVISION_MANIFEST` ; fermé par :
  codegraph.enabled et auto_provision à false, MCP codegraph coupé, réseau fermé.
- installation automatique de ripgrep par les outils grep et glob — preuve : `packages/omo-opencode/src/shared/ripgrep-cli.ts`, symbole
  `resolveGrepCliWithAutoInstall` ; fermé par : outils grep et glob coupés, réseau fermé.
- schéma de configuration de l'extension — preuve : `packages/omo-opencode/src/config-migration/schema-url.ts`, symbole `OMO_SCHEMA_URL` ; fermé par :
  aucune configuration écrite : les quatre dossiers de configuration sont en lecture seule (JS-2).
- serveurs MCP distants — preuve : `packages/omo-opencode/src/mcp/index.ts`, symbole `createBuiltinMcps` ; fermé par : les cinq MCP sont dans
  disabled_mcps, réseau fermé.
- crochets déclarés par le dépôt (Claude Code) — preuve : `packages/omo-opencode/src/hooks/claude-code-hooks/execute-http-hook.ts`, symbole
  `executeHttpHook` ; fermé par : hook claude-code-hooks coupé, claude_code tout à false, .claude/ refusé au pré-contrôle.
- résolution des redirections avant un appel web — preuve : `packages/omo-opencode/src/hooks/webfetch-redirect-guard/hook.ts`, symbole
  `resolveWebFetchRedirects` ; fermé par : hook coupé, webfetch refusé par la configuration d'instance, réseau fermé.
- passerelles OpenClaw — preuve : `packages/omo-opencode/src/config/schema/openclaw.ts`, symbole `OpenClawGatewaySchema` ; fermé par :
  openclaw.enabled à false, réseau fermé.

## 12. Écritures disque connues

Les deux premières lignes sont les migrations faites **au chargement de l'extension**, avant toute demande : ce sont elles que le
pré-contrôle du dépôt et de ses parents cherche à rendre inoffensives (JS-4).

<!-- table: disque -->
| Écriture | Chemin |
|---|---|
| renommage du dossier de travail hérité dans le projet, au chargement | `<projet>/.sisyphus → <projet>/.omo` |
| migration des configurations héritées, cherchées du projet jusqu'à la racine | `oh-my-openagent.json[c] et oh-my-opencode.json[c] de chaque dossier` |
| sauvegardes et journal de migration | `~/.omo/migration-backup-*, ~/.omo/.migration-journal.json, ~/.omo/.migration.lock` |
| état du travail en cours, plans et carnet partagé | `<projet>/.omo/boulder.json, <projet>/.omo/plans, <projet>/.omo/notepads` |
| ajout du greffon à la configuration de la TUI | `<dossier de configuration>/tui.json` |
| installation du binaire codegraph et de son index | `~/.omo/codegraph` |
| service LSP | `~/.omo/lsp-daemon` |
| équipes de Team Mode | `<projet>/.omo/teams` |
| état par session des hooks d'injection et de rappel | `fichiers JSON d'état de rules-injector, directory-agents-injector, agent-usage-reminder et interactive-bash-session` |
| transcription des crochets Claude Code, et un .gitignore posé à côté | `dossier de transcription des crochets` |
| cache des capacités des IA | `model-capabilities.json du dossier d'état` |
| état de la télémétrie | `posthog-activity.json du dossier d'état` |

Preuves :

- renommage du dossier de travail hérité dans le projet, au chargement — preuve : `packages/omo-opencode/src/shared/legacy-workspace-migration.ts`,
  symbole `migrateLegacyWorkspaceDirectory`.
- migration des configurations héritées, cherchées du projet jusqu'à la racine — preuve :
  `packages/omo-opencode/src/config-migration/discovery-paths.ts`, symbole `CONFIG_FILE_NAMES`.
- sauvegardes et journal de migration — preuve : `packages/omo-config-core/src/migration/journal.ts`, symbole `migrationJournalPath`.
- état du travail en cours, plans et carnet partagé — preuve : `packages/boulder-state/src/constants.ts`, symbole `BOULDER_FILE`.
- ajout du greffon à la configuration de la TUI — preuve : `packages/omo-opencode/src/cli/config-manager/add-tui-plugin-to-tui-config.ts`, symbole
  `ensureTuiPluginEntry`.
- installation du binaire codegraph et de son index — preuve : `packages/utils/src/codegraph/paths.ts`, symbole `codegraphDataRoot`.
- service LSP — preuve : `packages/utils/src/process-sweep/lsp-daemon-family.ts`, symbole `resolveLspDaemonBaseDir`.
- équipes de Team Mode — preuve : `packages/team-core/src/team-registry/paths.ts`, symbole `getTeamDirectory`.
- état par session des hooks d'injection et de rappel — preuve : `packages/omo-opencode/src/hooks/rules-injector/storage.ts`, symbole
  `RULES_INJECTOR_STORAGE`.
- transcription des crochets Claude Code, et un .gitignore posé à côté — preuve : `packages/omo-opencode/src/hooks/claude-code-hooks/transcript.ts`,
  symbole `TRANSCRIPT_DIR`.
- cache des capacités des IA — preuve : `packages/omo-opencode/src/shared/model-capabilities-cache.ts`, symbole `MODEL_CAPABILITIES_CACHE_FILE`.
- état de la télémétrie — preuve : `packages/telemetry-core/src/activity-state.ts`, symbole `POSTHOG_ACTIVITY_STATE_FILE`.

## 13. Fournisseurs coupés

`disabled_providers` porte les 25 identifiants de fournisseurs cités par le paquet, autres que `github-copilot` :

- `aihubmix`, `alibaba-token-plan`, `alibaba-token-plan-cn`, `anthropic`, `anthropic-api`, `bailian-coding-plan`, `deepseek`, `firmware`, `google`,
  `kimi-for-coding`, `minimax-cn-coding-plan`, `minimax-coding-plan`, `moonshotai`, `moonshotai-cn`, `ollama-cloud`, `openai`, `opencode`,
  `opencode-go`, `quotio-openai`, `qwen-token-plan`, `qwen-token-plan-cn`, `vercel`, `xai`, `xiaomi`, `zai-coding-plan`

C'est une seconde barrière : la première est `enabled_providers` limité à `github-copilot` dans la configuration d'instance. La
comparaison ne tient pas compte de la casse et n'accepte aucun joker (`plugin-config/config-merger.ts`).

## 14. À refaire à chaque montée de version

1. Relire le diff du paquet et reprendre les six énumérations : hooks, outils, MCP, compétences, commandes, clés.
2. Trancher chaque nom nouveau : toute clé non tranchée bloque la construction de l'image.
3. Relancer `app/server/omo-audit.test.ts` (document, table et JSON cohérents), puis la porte G12 sur l'image réelle, présences
   exigées : elle confirme les agents rendus et le chemin des sorties tronquées d'opencode.
4. Vérifier qu'aucune sous-chaîne du `dist` n'apparaît dans un fichier versionné (contrôle du banc, L21).

