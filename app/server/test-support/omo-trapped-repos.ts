// Les 15 dépôts piégés de la porte G8 (spécification l.1222, §3.15.2 l.523-530 ; plan d'exécution 2 bis-2 ter §6 L19a,
// D-2b-19, D-2b-34) : un dossier de travail factice, fabriqué dans un dossier temporaire, où chaque projet porte UN piège, dans
// le projet lui-même ou dans l'un de ses dossiers parents.
//
// Contenus **synthétiques** (D-2b-31) : aucun texte de l'extension n'est versionné ici, et aucun fichier ne contient de secret —
// les fichiers de clés piégés ne portent qu'une phrase de test. Rien n'est créé hors du dossier reçu en argument.
import fs from "node:fs";
import path from "node:path";
import type { OmoPrecheckReason } from "../shared/omo-precheck-rules.ts";

/** Marque des contenus fabriqués : reconnaissable dans un message d'échec, inoffensive dans un fichier. */
const CONTENU = "[synthétique] dépôt piégé du test L19a, aucun secret.";

export interface DepotPiege {
  /** Identifiant stable, repris dans les messages d'assertion. */
  id: string;
  /** Chemin du projet, relatif au dossier de travail fabriqué. */
  projet: string;
  /** Où le piège est posé : dans le projet ou dans l'un de ses parents. */
  ou: "projet" | "parent";
  /** Raison attendue du refus. */
  raison: OmoPrecheckReason;
  /** Ce qui est posé, en clair, pour le message d'assertion. */
  quoi: string;
}

/**
 * Les 15 pièges. Chaque `piegeNN` est un dossier parent du projet : y poser un piège prouve la remontée (D-2b-19), le poser
 * dans `projet` prouve le contrôle du projet lui-même.
 */
export const DEPOTS_PIEGES: readonly DepotPiege[] = Object.freeze([
  { id: "omo-json-projet", projet: "piege01/projet", ou: "projet", raison: "config-extension", quoi: ".omo/omo.json" },
  { id: "omo-jsonc-parent", projet: "piege02/projet", ou: "parent", raison: "config-extension", quoi: ".omo/omo.jsonc" },
  { id: "openagent-json-projet", projet: "piege03/projet", ou: "projet", raison: "config-extension", quoi: "oh-my-openagent.json" },
  { id: "openagent-jsonc-parent", projet: "piege04/projet", ou: "parent", raison: "config-extension", quoi: "oh-my-openagent.jsonc" },
  { id: "opencode-ancien-json-parent", projet: "piege05/projet", ou: "parent", raison: "config-extension", quoi: "oh-my-opencode.json" },
  { id: "opencode-ancien-jsonc-projet", projet: "piege06/projet", ou: "projet", raison: "config-extension", quoi: "oh-my-opencode.jsonc" },
  { id: "sisyphus-projet", projet: "piege07/projet", ou: "projet", raison: "config-extension", quoi: ".sisyphus/" },
  { id: "agents-skill-projet", projet: "piege08/projet", ou: "projet", raison: "config-extension", quoi: ".agents/skills/x/SKILL.md" },
  { id: "agents-skill-parent", projet: "piege09/projet", ou: "parent", raison: "config-extension", quoi: ".agents/skills/x/SKILL.md" },
  { id: "claude-projet", projet: "piege10/projet", ou: "projet", raison: "config-opencode", quoi: ".claude/" },
  { id: "mcp-json-parent", projet: "piege11/projet", ou: "parent", raison: "config-opencode", quoi: ".mcp.json" },
  { id: "opencode-dossier-projet", projet: "piege12/projet", ou: "projet", raison: "config-opencode", quoi: ".opencode/" },
  { id: "opencode-json-projet", projet: "piege13/projet", ou: "projet", raison: "config-opencode", quoi: "opencode.json" },
  { id: "opencode-jsonc-parent", projet: "piege14/projet", ou: "parent", raison: "config-opencode", quoi: "opencode.jsonc" },
  { id: "cle-parent", projet: "piege15/projet", ou: "parent", raison: "fichier-cle", quoi: "deploy.pfx" },
]);

/** Projet conforme fabriqué à côté des pièges : sans lui, un test qui refuse tout passerait quand même. */
export const PROJET_SAIN = "sain/projet";

/** Projet conforme qui porte les dossiers d'état créés par l'extension elle-même (T-L19-c). */
export const PROJET_ETAT_OMO = "etat/projet";

/** Tous les projets fabriqués, dans l'ordre : les 15 pièges, puis les deux projets conformes. */
export function projetsFabriques(): string[] {
  return [...DEPOTS_PIEGES.map((depot) => depot.projet), PROJET_SAIN, PROJET_ETAT_OMO];
}

function ecrire(racine: string, relatif: string, contenu = CONTENU): void {
  const cible = path.join(racine, relatif);
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  fs.writeFileSync(cible, contenu, "utf8");
}

function dossier(racine: string, relatif: string): void {
  fs.mkdirSync(path.join(racine, relatif), { recursive: true });
}

/** Dépôt git minimal : la forme de `.git` compte (D-2b-28), son contenu n'est jamais lu par le pré-contrôle. */
function projetVide(racine: string, projet: string): void {
  ecrire(racine, `${projet}/.git/HEAD`, "ref: refs/heads/principale\n");
  ecrire(racine, `${projet}/README.md`, CONTENU);
}

/**
 * Fabrique le dossier de travail factice : 15 projets piégés et deux projets conformes. `racine` doit être un dossier
 * temporaire vide ; rien n'est écrit ailleurs. Rend la liste des pièges, pour la boucle du test.
 */
export function fabriquerDepotsPieges(racine: string): readonly DepotPiege[] {
  for (const depot of DEPOTS_PIEGES) {
    projetVide(racine, depot.projet);
    const hote = depot.ou === "projet" ? depot.projet : path.posix.dirname(depot.projet);
    switch (depot.id) {
      case "omo-json-projet":
        ecrire(racine, `${hote}/.omo/omo.json`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "omo-jsonc-parent":
        ecrire(racine, `${hote}/.omo/omo.jsonc`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "openagent-json-projet":
        ecrire(racine, `${hote}/oh-my-openagent.json`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "openagent-jsonc-parent":
        ecrire(racine, `${hote}/oh-my-openagent.jsonc`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "opencode-ancien-json-parent":
        ecrire(racine, `${hote}/oh-my-opencode.json`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "opencode-ancien-jsonc-projet":
        ecrire(racine, `${hote}/oh-my-opencode.jsonc`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "sisyphus-projet":
        ecrire(racine, `${hote}/.sisyphus/etat.json`, '{"[synthétique]": "état piégé"}');
        break;
      case "agents-skill-projet":
      case "agents-skill-parent":
        ecrire(racine, `${hote}/.agents/skills/x/SKILL.md`, CONTENU);
        break;
      case "claude-projet":
        ecrire(racine, `${hote}/.claude/settings.json`, '{"[synthétique]": "réglages piégés"}');
        break;
      case "mcp-json-parent":
        ecrire(racine, `${hote}/.mcp.json`, '{"[synthétique]": "serveurs piégés"}');
        break;
      case "opencode-dossier-projet":
        ecrire(racine, `${hote}/.opencode/agent/x.md`, CONTENU);
        break;
      case "opencode-json-projet":
        ecrire(racine, `${hote}/opencode.json`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "opencode-jsonc-parent":
        ecrire(racine, `${hote}/opencode.jsonc`, '{"[synthétique]": "configuration piégée"}');
        break;
      case "cle-parent":
        ecrire(racine, `${hote}/deploy.pfx`, CONTENU);
        break;
      default:
        throw new Error(`Piège sans fabrique : ${depot.id}`);
    }
  }
  projetVide(racine, PROJET_SAIN);
  ecrire(racine, `${PROJET_SAIN}/package.json`, '{"name": "projet-sain", "private": true}');
  ecrire(racine, `${PROJET_SAIN}/.vscode/settings.json`, '{"[synthétique]": "réglages d\'IDE"}');
  projetVide(racine, PROJET_ETAT_OMO);
  ecrire(racine, `${PROJET_ETAT_OMO}/.omo/boulder.json`, '{"[synthétique]": "état de l\'extension"}');
  ecrire(racine, `${PROJET_ETAT_OMO}/.omo/boulder-2.json`, '{"[synthétique]": "état de l\'extension"}');
  dossier(racine, `${PROJET_ETAT_OMO}/.omo/plans`);
  ecrire(racine, `${PROJET_ETAT_OMO}/.omo/plans/plan-1.md`, CONTENU);
  dossier(racine, `${PROJET_ETAT_OMO}/.omo/notepads`);
  ecrire(racine, `${PROJET_ETAT_OMO}/.omo/notepads/carnet-1.md`, CONTENU);
  return DEPOTS_PIEGES;
}

/** Projet conforme isolé (dossier de travail à part), pour les tests qui posent eux-mêmes ce qu'ils veulent. */
export function fabriquerProjet(racine: string, projet: string): string {
  projetVide(racine, projet);
  return path.join(racine, projet);
}

/** Pose un fichier au contenu synthétique dans un dossier fabriqué. */
export function poser(racine: string, relatif: string, contenu = CONTENU): string {
  ecrire(racine, relatif, contenu);
  return path.join(racine, relatif);
}
