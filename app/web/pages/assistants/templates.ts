// Pré-remplissage de l'assistant de création selon le type de tâche, et petits utilitaires de brouillon.
import { ficheSentence, USE_CASE_INFO } from "../../../server/shared/assistant-rules.ts";
import type { AssistantDraft, RightsProfile, TaskSize, Tier, UseCase } from "../../lib/types.ts";

export interface UseCasePreset {
  rights: RightsProfile;
  tier: Tier;
  taskSize: TaskSize;
  instructions: string;
}

/** Droits, niveau, taille et consignes d'exemple proposés par chaque carte « Type de tâche ». */
export const USE_CASE_PRESETS: Readonly<Record<UseCase, UseCasePreset>> = Object.freeze({
  analyser: {
    rights: "lecture",
    tier: "equilibre",
    taskSize: "M",
    instructions: [
      "Tu aides à analyser un incident, une alerte ou des journaux.",
      "",
      "1. Résume ce qui s'est passé en trois lignes au plus.",
      "2. Liste les indices trouvés dans ce qu'on te donne : messages d'erreur, horodatages, services touchés.",
      "3. Propose les causes possibles, de la plus probable à la moins probable, avec ce qui permettrait de les confirmer.",
      "4. Propose les vérifications à faire, sans jamais les exécuter toi-même.",
      "",
      "Ne modifie rien. Réponds en français, avec des titres courts et des listes.",
    ].join("\n"),
  },
  relire: {
    rights: "lecture",
    tier: "equilibre",
    taskSize: "M",
    instructions: [
      "Tu relis un script, une requête ou du code d'infrastructure avant sa mise en production.",
      "",
      "1. Explique en deux lignes ce que fait le contenu relu.",
      "2. Signale les risques : opérations destructrices, gestion d'erreur absente, secrets en clair, actions non rejouables, droits trop larges.",
      "3. Pour chaque risque, indique la ligne concernée, la gravité (bloquant, important, mineur) et une correction proposée.",
      "4. Termine par la liste des tests à faire hors production.",
      "",
      "Ne modifie aucun fichier. Réponds en français, avec des listes.",
    ].join("\n"),
  },
  rediger: {
    rights: "propose",
    tier: "equilibre",
    taskSize: "M",
    instructions: [
      "Tu aides à rédiger ou mettre à jour un document d'exploitation : runbook, postmortem ou communication.",
      "",
      "1. Demande ce qui manque avant d'écrire : public visé, contexte, étapes connues.",
      "2. Propose un plan, puis rédige chaque partie de façon claire et vérifiable.",
      "3. Pour un runbook : prérequis, étapes numérotées, vérification après chaque étape, retour arrière.",
      "4. Écris « À VÉRIFIER » partout où une information doit être confirmée par l'équipe.",
      "",
      "Avant de créer ou de modifier un fichier, montre le texte proposé. Réponds en français.",
    ].join("\n"),
  },
  expliquer: {
    rights: "lecture",
    tier: "rapide",
    taskSize: "S",
    instructions: [
      "Tu expliques du code existant ou une documentation à un collègue qui découvre le sujet.",
      "",
      "1. Commence par le rôle général, en deux ou trois phrases.",
      "2. Détaille ensuite les parties importantes, dans l'ordre où elles s'exécutent.",
      "3. Définis chaque terme technique la première fois qu'il apparaît.",
      "4. Termine par les points d'attention ou les zones à clarifier.",
      "",
      "Ne modifie rien. Réponds en français, simplement.",
    ].join("\n"),
  },
  autre: {
    rights: "lecture",
    tier: "equilibre",
    taskSize: "M",
    instructions: [
      "Tu aides l'équipe pour la tâche suivante : (décrivez-la ici).",
      "",
      "1. Ce que tu dois faire, étape par étape.",
      "2. Ce que tu ne dois jamais faire.",
      "3. La forme attendue de la réponse : liste, tableau ou texte court.",
      "",
      "Réponds en français.",
    ].join("\n"),
  },
});

/** Consignes sans les phrases « Consulte la fiche « x » avant de répondre. » (ajoutées quand une fiche est cochée). */
export function withoutFicheSentences(instructions: string): string {
  return instructions
    .split("\n")
    .filter((line) => !/^Consulte la fiche « [^»]+ » avant de répondre\.$/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ajoute à la fin des consignes la phrase de chaque fiche qui n'y figure pas encore. */
export function withFicheSentences(instructions: string, fiches: readonly string[]): string {
  const missing = fiches.map(ficheSentence).filter((sentence) => !instructions.includes(sentence));
  if (missing.length === 0) return instructions;
  const base = instructions.replace(/\s+$/, "");
  return base ? `${base}\n\n${missing.join("\n")}` : missing.join("\n");
}

/** Retire la phrase d'une fiche décochée. */
export function removeFicheSentence(instructions: string, fiche: string): string {
  const sentence = ficheSentence(fiche);
  return instructions
    .split("\n")
    .filter((line) => line.trim() !== sentence)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

/** true si les consignes sont vides ou identiques à un exemple livré (hors phrases de fiches). */
export function isPresetInstructions(instructions: string): boolean {
  const text = withoutFicheSentences(instructions);
  return text === "" || Object.values(USE_CASE_PRESETS).some((preset) => preset.instructions === text);
}

/** « relire-script » → « Relire script » (titre proposé pour « Compléter »). */
export function humanizeName(name: string): string {
  const text = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : name;
}

/** Brouillon vide d'un nouvel assistant (type « Autre »). */
export function emptyDraft(useCase: UseCase = "autre"): AssistantDraft {
  const preset = USE_CASE_PRESETS[useCase];
  return {
    title: "",
    description: "",
    useCase,
    rights: preset.rights,
    web: false,
    tier: preset.tier,
    model: null,
    reflection: "standard",
    taskSize: preset.taskSize,
    instructions: preset.instructions,
    fiches: [],
    examples: [],
    icon: USE_CASE_INFO[useCase].icon,
  };
}
