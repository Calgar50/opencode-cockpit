// Propriétaire : L12c.
// Journal du contrôle d'une demande (spécification §4.12, §5.4, §5.5, §5.6), rendu par le Déroulé : tableau Heure · Qui · Action
// (masquée, 120 caractères, bornée par le serveur) · Décision · Par · Règle · Raison · Coût du contrôle, et repères mot + icône
// des lignes d'acteur du Déroulé, dont la règle et la raison s'atteignent au clavier (focus) et au clic.
// Source unique : GET /api/conversations/:rootId/activity (L4b), lu seulement quand un fait « decision » existe (P12 : aucun
// signe sans fait enregistré) ; aucune route nouvelle, aucune écriture. Les libellés viennent de server/shared/autonomy-texts.ts
// (L9b) : libelleDecision, libellePar, phraseRegle, regleCarte, montant ; aucune phrase n'est réécrite ici.
// Le résumé de l'action et la raison sont des DONNÉES (déjà masquées et bornées par le serveur) : React les échappe, elles ne
// sont jamais interprétées. Aucune animation (web-animations.test.ts) ; le mot dit la décision, l'icône l'accompagne.
// Composant interne : ses propriétés restent libres pour son propriétaire (Déroulé).
import { useId, useMemo, useState } from "react";
import { libelleDecision, libellePar, montant, phraseRegle, regleCarte, TEXTES } from "../../../../server/shared/autonomy-texts.ts";
import { Icon, type IconName } from "../../../components/Icon.tsx";
import { useAsync } from "../../../components/ui.tsx";
import { activityApi } from "../../../lib/api-activity.ts";
import { errorText } from "../../../lib/api.ts";
import type { DecisionBy, DecisionVerdict, DecisionView } from "../../../lib/types.ts";
import "./autonomy-journal.css";

const JOURNAL = TEXTES.partout.journal;

/** Heure d'une décision, à la seconde (§4.12 : « 10:42:03 ») : deux décisions peuvent tomber dans la même minute. */
const heureFr = new Intl.DateTimeFormat("fr-FR", { timeStyle: "medium" });

/** Verdicts de l'instance principale, dans l'ordre d'affichage des repères ; « refus-interdit » est réservé à la Salle OMO. */
const VERDICTS: readonly Exclude<DecisionVerdict, "refus-interdit">[] = ["auto", "attente", "refus-auto", "non-controle"];

/** Icône de chaque décision : le mot reste le texte, l'icône l'accompagne (jamais la couleur seule, §5.5). */
const VERDICT_ICONS: Readonly<Record<Exclude<DecisionVerdict, "refus-interdit">, IconName>> = {
  auto: "check",
  attente: "hourglass",
  "refus-auto": "ban",
  "non-controle": "alert",
};

/** Lignes de détail d'un repère : au-delà, le Journal montre le reste. */
const DETAIL_MAX = 4;

const isMainVerdict = (verdict: DecisionVerdict): verdict is Exclude<DecisionVerdict, "refus-interdit"> =>
  (VERDICTS as readonly string[]).includes(verdict);

const isMainBy = (par: DecisionBy): par is Exclude<DecisionBy, "extension"> => par !== "extension";

/** Décision de l'instance principale : la Salle OMO (verdict « refus-interdit », par « extension ») arrive en itération 2 ter. */
function estPrincipale(decision: DecisionView): boolean {
  return isMainVerdict(decision.verdict) && isMainBy(decision.par);
}

export interface JournalTextOptions {
  advanced: boolean;
  /** budget.autonomie.controleIa : change la phrase des commandes inconnues (décision n° 8). */
  controleIa: boolean;
}

/** Phrase d'une règle dans le mode et la variante d'IA de contrôle en vigueur. */
function phrase(regle: string, options: JournalTextOptions): string {
  return phraseRegle(regle, { mode: options.advanced ? "avance" : "simple", controleIa: options.controleIa });
}

/** Raison affichée : celle du serveur (masquée, bornée) ; à défaut, la phrase de la règle. */
function raisonAffichee(decision: DecisionView, options: JournalTextOptions): string {
  const raison = decision.raison.trim();
  return raison === "" ? phrase(decision.regle, options) : raison;
}

/** Coût du contrôle par IA d'une ligne : « — » quand aucune IA n'a été appelée. */
function coutControle(decision: DecisionView): string {
  return decision.iaCost === null ? TEXTES.partout.montantInconnu : montant(decision.iaCost);
}

/**
 * Décisions d'une conversation, lues une fois par ouverture et relues quand le nombre de faits « decision » change. `attendu` à
 * zéro : aucune décision enregistrée, donc aucune lecture (P12 : le signe vient du fait, jamais l'inverse).
 */
export function useControlDecisions(rootId: string, attendu: number): { decisions: DecisionView[]; error: string | null; chargement: boolean } {
  const lu = useAsync(async () => (attendu > 0 ? await activityApi.activity(rootId) : null), [rootId, attendu]);
  const decisions = useMemo(() => (lu.data?.decisions ?? []).filter(estPrincipale), [lu.data]);
  const error = lu.error === null || lu.error === undefined ? null : errorText(lu.error);
  return { decisions, error, chargement: attendu > 0 && lu.data === null && error === null };
}

export interface ControlJournalProps {
  decisions: DecisionView[];
  advanced: boolean;
  /** budget.autonomie.controleIa (amorçage) : variante des phrases de règle. */
  controleIa: boolean;
  /** Nom d'acteur par session (colonne « Qui ») ; session absente : « Travail délégué ». */
  noms?: ReadonlyMap<string, string> | undefined;
  /** Lecture des décisions en cours : ne jamais dire « aucune décision » avant d'avoir lu (P3). */
  chargement?: boolean | undefined;
  /** Lecture impossible (GET …/activity) : dit, jamais tu (P3). */
  error?: string | null | undefined;
  /**
   * État vide (§5.4) : « Aucune décision automatique pour cette demande. », écrit par le Déroulé, qui sait si la fenêtre est une
   * demande ou toute la conversation. Absent : la phrase du module de textes.
   */
  vide?: string | undefined;
}

/** Ligne d'acteur que le Déroulé ne montre pas (fenêtre choisie, bornes du Déroulé) : même nom que le Déroulé lui donnerait. */
const TRAVAIL_DELEGUE = "Travail délégué";

/** Nom d'acteur de la colonne « Qui » : celui que le Déroulé donne à la session ; à défaut, le travail délégué. */
function qui(decision: DecisionView, noms: ReadonlyMap<string, string> | undefined): string {
  return noms?.get(decision.sessionId) ?? TRAVAIL_DELEGUE;
}

/** Journal du contrôle (§4.12) : `<table>` (§5.5), texte échappé, état vide quand aucune décision n'a été enregistrée. */
export function ControlJournal({ decisions, advanced, controleIa, noms, chargement, error, vide }: ControlJournalProps) {
  const options: JournalTextOptions = { advanced, controleIa };
  if (error) return <p className="callout critical small">{error}</p>;
  if (decisions.length === 0) {
    // Des décisions sont enregistrées mais la lecture n'est pas finie : ne jamais dire « aucune décision » à tort (P3).
    return <p className="small muted">{chargement ? "Lecture du journal…" : (vide ?? JOURNAL.vide)}</p>;
  }
  return (
    <div className="table-wrap journal-wrap">
      <table className="table journal-table">
        <caption className="visually-hidden">{JOURNAL.titre}</caption>
        <thead>
          <tr>
            <th scope="col">{JOURNAL.colonnes.heure}</th>
            <th scope="col">{JOURNAL.colonnes.qui}</th>
            <th scope="col">{JOURNAL.colonnes.action}</th>
            <th scope="col">{JOURNAL.colonnes.decision}</th>
            <th scope="col">{JOURNAL.colonnes.par}</th>
            <th scope="col">{JOURNAL.colonnes.regle}</th>
            <th scope="col">{JOURNAL.colonnes.raison}</th>
            <th scope="col" className="num">
              {JOURNAL.colonnes.cout}
            </th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((decision) => (
            <tr key={decision.id}>
              <td className="nowrap">{heureFr.format(decision.askedAt)}</td>
              <th scope="row" className="journal-qui">
                {qui(decision, noms)}
              </th>
              <td>
                <code className="journal-action">{decision.resume}</code>
              </td>
              <td className="journal-decision">
                {isMainVerdict(decision.verdict) ? (
                  <span className="journal-mot nowrap">
                    <Icon name={VERDICT_ICONS[decision.verdict]} size={12} />
                    {libelleDecision(decision.verdict)}
                  </span>
                ) : (
                  decision.verdict
                )}
              </td>
              <td>{isMainBy(decision.par) ? libellePar(decision.par) : decision.par}</td>
              <td>
                <code>{decision.regle}</code>
              </td>
              <td className="journal-raison">{raisonAffichee(decision, options)}</td>
              <td className="num nowrap">{coutControle(decision)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Repère d'une ligne d'acteur : un verdict, son nombre, et les couples règle/raison à montrer au focus. */
interface Repere {
  verdict: Exclude<DecisionVerdict, "refus-interdit">;
  nombre: number;
  details: string[];
}

/** Repères d'une session : un par verdict rencontré, dans l'ordre fixe des verdicts ; détails dédoublonnés et bornés. */
export function reperesDeSession(decisions: readonly DecisionView[], sessionId: string, options: JournalTextOptions): Repere[] {
  const out: Repere[] = [];
  for (const verdict of VERDICTS) {
    const lignes = decisions.filter((d) => d.sessionId === sessionId && d.verdict === verdict);
    if (lignes.length === 0) continue;
    const details: string[] = [];
    for (const ligne of lignes) {
      const regle = regleCarte(ligne.regle, { mode: options.advanced ? "avance" : "simple", controleIa: options.controleIa });
      const raison = raisonAffichee(ligne, options);
      const texte = raison === phrase(ligne.regle, options) ? regle : `${regle} · ${raison}`;
      if (!details.includes(texte) && details.length < DETAIL_MAX) details.push(texte);
    }
    out.push({ verdict, nombre: lignes.length, details });
  }
  return out;
}

/**
 * Repères mot et icône d'une ligne d'acteur du Déroulé (§4.12) : chaque repère est un bouton ; sa règle et sa raison s'affichent
 * au focus (clavier) et restent affichées après un clic (tactile). Rien quand la session n'a pris aucune décision.
 */
export function DecisionMarks({
  decisions,
  sessionId,
  advanced,
  controleIa,
}: {
  decisions: readonly DecisionView[];
  sessionId: string;
  advanced: boolean;
  controleIa: boolean;
}) {
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const baseId = useId();
  const reperes = useMemo(() => reperesDeSession(decisions, sessionId, { advanced, controleIa }), [decisions, sessionId, advanced, controleIa]);
  if (reperes.length === 0) return null;
  return (
    <ul className="journal-reperes">
      {reperes.map((repere) => {
        const montre = ouvert === repere.verdict || focus === repere.verdict;
        const detailId = `${baseId}-${repere.verdict}`;
        return (
          <li key={repere.verdict} className="journal-repere">
            <button
              type="button"
              className={`journal-repere-bouton journal-repere--${repere.verdict}`}
              aria-expanded={montre}
              aria-controls={detailId}
              onClick={() => setOuvert((v) => (v === repere.verdict ? null : repere.verdict))}
              onFocus={() => setFocus(repere.verdict)}
              onBlur={() => setFocus((v) => (v === repere.verdict ? null : v))}
            >
              <Icon name={VERDICT_ICONS[repere.verdict]} size={12} />
              <span>{libelleDecision(repere.verdict)}</span>
              {repere.nombre > 1 ? <span className="journal-repere-nombre">{repere.nombre}</span> : null}
            </button>
            <ul id={detailId} className="journal-repere-detail tiny" hidden={!montre}>
              {repere.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
