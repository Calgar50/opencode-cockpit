// Textes du tableau « Ce que l'extension fait sans demande » (spécification §4.10 l.759, §3.6 ; plan d'exécution, fiche L20).
// Le tableau est ENGENDRÉ depuis la table d'audit (omo-audit-4.19.4.ts) : une ligne par outil et par automatisme gardé qui agit
// sans passer par une demande d'autorisation. Ajouter une entrée à la table ajoute une ligne, la couper la retire : le tableau ne
// peut pas mentir sur ce qui est en service.
//
// La Salle OMO n'existe qu'en mode Avancé : tous les textes sont rangés dans « avance ». Convention TEXTES de T0, contrôlée par
// textes.test.ts. Module pur (server/shared).
import { HOOKS, type OmoHookAudit, type OmoOutilAudit, OUTILS } from "./omo-audit-4.19.4.ts";

export const TEXTES = {
  simple: {},
  avance: {
    titre: "Ce que l'extension fait sans demande",
    intro:
      "Dans la Salle OMO, l'extension enchaîne ces actions d'elle-même : elles ne vous sont pas soumises avant d'avoir lieu. Le cockpit les compte, les montre et arrête la demande aux plafonds.",
    colonnes: {
      nom: "Nom dans l'extension",
      origine: "Origine",
      quoi: "Ce qu'elle fait",
    },
    origines: {
      outil: "Outil",
      hook: "Automatisme",
    },
    /** Une entrée par nom de la table d'audit gardé et marqué « sans demande ». Aucun autre nom n'est affiché. */
    sansDemande: {
      background_output: "Relève le résultat d'un travail lancé en arrière-plan.",
      background_cancel: "Abandonne un travail lancé en arrière-plan.",
      call_omo_agent: "Confie un travail à un autre assistant de l'extension.",
      task: "Confie un travail à un autre assistant, en attendant le résultat ou en arrière-plan.",
      atlas: "Suit le plan et confie les tâches une à une jusqu'au bout.",
      "delegate-task-retry": "Recommence un travail confié qui s'est arrêté en erreur.",
      "keyword-detector": "Complète votre message avant l'envoi quand il contient un mot-clé de l'extension.",
      "preemptive-compaction": "Résume la mémoire de la conversation avant sa limite : ce résumé appelle l'IA et coûte.",
      "sisyphus-junior-notepad": "Écrit des notes dans les fichiers partagés du projet, que les assistants relisent.",
      "start-work": "Ouvre une séance de travail à partir d'un plan.",
      "todo-continuation-enforcer": "Relance la liste de tâches tant qu'elle n'est pas terminée.",
      "unstable-agent-babysitter": "Relance un assistant resté muet.",
    },
    /** Rappel affiché sous le tableau. */
    rappel: "Cette liste vient de l'audit de la version installée. Les détections du cockpit la complètent, elles ne la remplacent pas.",
    /** Gabarit du bandeau de version (§3.6). */
    versionAuditee: "Version {version}, auditée le {date}",
    /** Affiché quand la table ne garde aucune action de ce genre. */
    aucune: "Aucune : l'extension ne fait rien sans passer par une demande.",
  },
  partout: {},
};

export interface LigneSansDemande {
  nom: string;
  categorie: "outil" | "hook";
  libelle: string;
}

/**
 * Tableau du §4.10, engendré depuis la table d'audit : outils gardés puis automatismes gardés, dans l'ordre de la table. Un nom
 * sans libellé se rend sous son nom brut, ce qu'un test refuse : aucun trou silencieux.
 */
export function tableauSansDemande(outils: readonly OmoOutilAudit[] = OUTILS, hooks: readonly OmoHookAudit[] = HOOKS): LigneSansDemande[] {
  const libelles: Record<string, string> = TEXTES.avance.sansDemande;
  const lignes: LigneSansDemande[] = [];
  for (const outil of outils) {
    if (outil.decision === "garder" && outil.sansDemande) lignes.push({ nom: outil.nom, categorie: "outil", libelle: libelles[outil.nom] ?? outil.nom });
  }
  for (const hook of hooks) {
    if (hook.decision === "garder" && hook.sansDemande) lignes.push({ nom: hook.nom, categorie: "hook", libelle: libelles[hook.nom] ?? hook.nom });
  }
  return lignes;
}

/** Bandeau de version : gabarit rempli par l'appelant, jamais une chaîne construite ailleurs. */
export function formatVersionAuditee(version: string, date: string): string {
  return TEXTES.avance.versionAuditee.replace("{version}", version).replace("{date}", date);
}
