// Disposition, liste et droits d'un déroulé d'équipe (itération 4, plan d'exécution it4 §6 fiche L36b et §4.1.1 ; spécification
// §3.1 l.129, §5.3, §5.4 ; conception C §6.4 ; étude A §6 « disposition calculée par les données ») : module PUR (ni « node: »,
// ni process, ni horloge, ni aléa, ni réseau), partagé avec l'interface.
//
// - layoutFlow : une ligne par bloc (un bloc d'avis en donne deux : les avis, puis la synthèse). La disposition vient des DONNÉES,
//   jamais de coordonnées écrites à la main, et chaque cellule porte l'identifiant stable de son étape : FlowSchema (L40a) place
//   les colonnes et les liens à partir de là, et `recoitDe` dit d'où vient chaque flèche.
// - flowAsList : la description longue, VÉRITÉ pour le lecteur d'écran (§5.5, U11) : FlowList la rend sous le schéma, qui reste
//   décoratif. Aucun texte n'est écrit ici : toutes les phrases viennent de team-texts.ts (T4t).
// - rightsUnion : « Ce que cette équipe peut faire » — les droits de chaque assistant SOUS le plancher ETAPE, fusionnés. Le
//   plancher est ajouté après les règles de l'assistant, comme opencode les applique (la dernière règle l'emporte, F-a/F-d) :
//   aucune étape ne modifie, ne lance de commande, ne va sur Internet ni ne délègue, même si son assistant le peut ailleurs.
//
// L'ordre d'exécution vient de planSteps et la sémantique de `recoit` de receivedFrom (team-limits.ts, T4), consommées telles
// quelles. Aucun import de flow.ts (L36a, écrit en parallèle dans la même vague).
import { type RightLine, rightLines, type Rule } from "./assistant-rules.ts";
import { buildFloor } from "./session-floors.ts";
import { planSteps, receivedFrom } from "./team-limits.ts";
import { remplir, TEXTES } from "./team-texts.ts";
import type { Flow, FlowRow, FlowStep, StepAssistant } from "./team-types.ts";

/** Noms lisibles des assistants (nom technique → titre) ; un assistant absent de la table garde son nom. */
export type AssistantNames = ReadonlyMap<string, string>;

const P = TEXTES.partout;

function nomDe(noms: AssistantNames, assistant: string): string {
  return noms.get(assistant) ?? assistant;
}

function cellule(step: FlowStep, noms: AssistantNames): FlowRow["cellules"][number] {
  return { stepId: step.id, titre: step.titre, sousTitre: nomDe(noms, step.assistant) };
}

/** Identifiants dans l'ordre d'arrivée, sans doublon. */
function sansDoublon(listes: readonly string[][]): string[] {
  const out: string[] = [];
  for (const liste of listes) for (const id of liste) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Disposition du schéma, ligne par ligne, de haut en bas : un bloc « etape » donne une ligne d'une cellule ; un bloc « avis »
 * donne une ligne de N cellules (les avis, côte à côte, lancés en même temps) puis une ligne pour sa synthèse ; un bloc « pause »
 * donne une ligne sans étape, dont le sous-titre est ce que vous voulez vérifier.
 */
export function layoutFlow(flow: Flow, noms: AssistantNames): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const block of flow.blocs) {
    if (block.type === "etape") {
      rows.push({ bloc: block.id, kind: "etape", cellules: [cellule(block.etape, noms)], recoitDe: receivedFrom(flow, block.etape.id) });
    } else if (block.type === "avis") {
      rows.push({
        bloc: block.id,
        kind: "avis",
        cellules: block.avis.map((avis) => cellule(avis, noms)),
        recoitDe: sansDoublon(block.avis.map((avis) => receivedFrom(flow, avis.id))),
      });
      rows.push({
        bloc: block.id,
        kind: "synthese",
        cellules: [cellule(block.synthese, noms)],
        recoitDe: receivedFrom(flow, block.synthese.id),
      });
    } else if (block.type === "pause") {
      rows.push({ bloc: block.id, kind: "pause", cellules: [{ stepId: null, titre: P.execution.pause, sousTitre: block.message }], recoitDe: [] });
    }
  }
  return rows;
}

/** Ce que l'étape reçoit, dit par le texte de T4t ; chaîne vide pour une valeur hors de la liste fermée (JSON non validé). */
function phraseRecoit(step: FlowStep): string {
  const choix = P.editeur.champs.recoitChoix;
  return Object.hasOwn(choix, step.recoit) ? choix[step.recoit] : "";
}

function ligneEtape(step: FlowStep, ordres: ReadonlyMap<string, number>, noms: AssistantNames): string {
  const suite = [step.titre, nomDe(noms, step.assistant), phraseRecoit(step)].filter((part) => part !== "");
  return `${P.etape} ${ordres.get(step.id) ?? 0} : ${suite.join(" · ")}`;
}

/**
 * Description longue du déroulé, une phrase par ligne, dans l'ordre d'exécution (planSteps) : chaque étape porte son rang, son
 * titre, son assistant et ce qu'elle reçoit ; un bloc d'avis est annoncé par « En même temps : … » ; une pause dit ce que vous
 * vérifiez. C'est cette liste que lit un lecteur d'écran (U11), pas le schéma.
 */
export function flowAsList(flow: Flow, noms: AssistantNames): string[] {
  const ordres = new Map(planSteps(flow).map((planned) => [planned.stepId, planned.ordre]));
  const lignes: string[] = [];
  for (const block of flow.blocs) {
    if (block.type === "etape") {
      lignes.push(ligneEtape(block.etape, ordres, noms));
    } else if (block.type === "avis") {
      lignes.push(remplir(P.feuille.enMemeTemps, { titres: block.avis.map((avis) => avis.titre).join(", ") }));
      for (const avis of block.avis) lignes.push(ligneEtape(avis, ordres, noms));
      lignes.push(ligneEtape(block.synthese, ordres, noms));
    } else if (block.type === "pause") {
      lignes.push(block.message === "" ? P.execution.pause : `${P.execution.pause} : ${block.message}`);
    }
  }
  return lignes;
}

/** Du plus refusé au plus permissif : l'union d'une équipe garde, pour chaque ligne, ce que l'étape la plus permissive peut faire. */
const RANG: Readonly<Record<string, number>> = Object.freeze({ deny: 0, ask: 1, allow: 2 });

/** Assistants du déroulé, dans l'ordre d'exécution, sans doublon. */
function assistantsDuFlow(flow: Flow): string[] {
  const steps = new Map<string, FlowStep>();
  for (const block of flow.blocs) {
    if (block.type === "etape") steps.set(block.etape.id, block.etape);
    else if (block.type === "avis") for (const step of [...block.avis, block.synthese]) steps.set(step.id, step);
  }
  const noms: string[] = [];
  for (const planned of planSteps(flow)) {
    const step = steps.get(planned.stepId);
    if (step && !noms.includes(step.assistant)) noms.push(step.assistant);
  }
  return noms;
}

/**
 * « Ce que cette équipe peut faire » : pour chaque assistant du déroulé, les lignes ✓ / ✗ / ? calculées sur ses règles SUIVIES du
 * plancher ETAPE, puis fusionnées ligne à ligne en gardant la plus permissive (ce que l'équipe peut faire, pas ce qu'elle fait le
 * moins). Un assistant absent de la table est ignoré : c'est un problème de grammaire (`assistant-absent`, L36a), pas un droit.
 *
 * La ligne « Vous rend la main après {steps} actions au maximum » n'entre pas dans l'union : chaque étape a sa propre limite, et
 * `steps` est une consigne donnée à l'IA, pas une borne appliquée par opencode (mesures ME-2 et ME-7). Elle reste rendue par
 * étape (StepRunView.droits, L37b).
 */
export function rightsUnion(flow: Flow, assistants: ReadonlyMap<string, StepAssistant>): RightLine[] {
  const ordre: string[] = [];
  const retenues = new Map<string, RightLine>();
  for (const nom of assistantsDuFlow(flow)) {
    const assistant = assistants.get(nom);
    if (!assistant) continue;
    const regles: Rule[] = [...assistant.rules, ...buildFloor("ETAPE", { agentRules: assistant.rules })];
    for (const ligne of rightLines(regles)) {
      const retenue = retenues.get(ligne.id);
      if (!retenue) {
        ordre.push(ligne.id);
        retenues.set(ligne.id, ligne);
      } else if ((RANG[ligne.action ?? "deny"] ?? 0) > (RANG[retenue.action ?? "deny"] ?? 0)) {
        retenues.set(ligne.id, ligne);
      }
    }
  }
  return ordre.flatMap((id) => {
    const ligne = retenues.get(id);
    return ligne ? [ligne] : [];
  });
}
