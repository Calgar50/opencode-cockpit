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
// 1.1 (L26b), Salle OMO (§4.12 l.784, §5.7.4 l.987) : le Journal montre AUSSI le verdict « refus-interdit », les actions
// « par : extension » — marquées « non contrôlé avant exécution » —, les détections après coup et les fichiers mis de côté.
// Ces lignes n'existent que dans une conversation de la salle ; ailleurs, le tableau est celui de l'instance principale, à
// l'identique. Les détections et la quarantaine arrivent par PROPRIÉTÉS (aucune route nouvelle, aucun appel d'ici) : leurs
// phrases viennent de server/shared/omo-room-texts.ts, par omo-journal.ts.
import { useId, useMemo, useState } from "react";
import { libelleDecision as libelleDecisionPrincipale, libellePar, montant, phraseRegle, regleCarte, TEXTES } from "../../../../server/shared/autonomy-texts.ts";
import type { OmoSignale } from "../../../../server/shared/omo-types.ts";
import { Icon, type IconName } from "../../../components/Icon.tsx";
import { useAsync } from "../../../components/ui.tsx";
import { activityApi } from "../../../lib/api-activity.ts";
import { errorText } from "../../../lib/api.ts";
import type { DecisionBy, DecisionVerdict, DecisionView } from "../../../lib/types.ts";
import {
  DECISION_REFUS_INTERDIT,
  type JournalDetection,
  marquesOmo,
  PAR_EXTENSION,
  phraseDetectionJournal,
  phraseQuarantaine,
} from "./omo-journal.ts";
import "./autonomy-journal.css";

const JOURNAL = TEXTES.partout.journal;

/** Heure d'une décision, à la seconde (§4.12 : « 10:42:03 ») : deux décisions peuvent tomber dans la même minute. */
const heureFr = new Intl.DateTimeFormat("fr-FR", { timeStyle: "medium" });

/** Verdicts dans l'ordre d'affichage des repères ; « refus-interdit » n'apparaît que dans une conversation de la Salle OMO. */
const VERDICTS: readonly DecisionVerdict[] = ["auto", "attente", "refus-auto", "non-controle", "refus-interdit"];

/** Icône de chaque décision : le mot reste le texte, l'icône l'accompagne (jamais la couleur seule, §5.5). */
const VERDICT_ICONS: Readonly<Record<DecisionVerdict, IconName>> = {
  auto: "check",
  attente: "hourglass",
  "refus-auto": "ban",
  "non-controle": "alert",
  "refus-interdit": "lock",
};

/** Lignes de détail d'un repère : au-delà, le Journal montre le reste. */
const DETAIL_MAX = 4;

const isMainVerdict = (verdict: DecisionVerdict): verdict is Exclude<DecisionVerdict, "refus-interdit"> => verdict !== "refus-interdit";

const isMainBy = (par: DecisionBy): par is Exclude<DecisionBy, "extension"> => par !== "extension";

/** Libellé de la colonne « Décision » : celui de l'instance principale, ou celui de l'interdit absolu de la salle. */
function libelleDecision(verdict: DecisionVerdict): string {
  return isMainVerdict(verdict) ? libelleDecisionPrincipale(verdict) : DECISION_REFUS_INTERDIT;
}

/** Libellé de la colonne « Par » : celui de l'instance principale, ou l'extension de la salle. */
function libelleQuiDecide(par: DecisionBy): string {
  return isMainBy(par) ? libellePar(par) : PAR_EXTENSION;
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

/**
 * Raison affichée : celle du serveur (masquée, bornée) ; à défaut, la phrase de la règle. Une ligne de la Salle OMO y ajoute le
 * message de l'interdit absolu et la marque « non contrôlé avant exécution » (§5.7.4), tous deux repris tels quels des textes.
 */
function raisonAffichee(decision: DecisionView, options: JournalTextOptions): string {
  const raison = decision.raison.trim();
  const base = raison === "" && isMainVerdict(decision.verdict) ? phrase(decision.regle, options) : raison;
  return [base, ...marquesOmo(decision)].filter((part) => part !== "").join(" · ");
}

/** Coût du contrôle par IA d'une ligne : « — » quand aucune IA n'a été appelée. */
function coutControle(decision: DecisionView): string {
  return decision.iaCost === null ? TEXTES.partout.montantInconnu : montant(decision.iaCost);
}

/**
 * Décisions d'une conversation, lues une fois par ouverture et relues quand le nombre de faits « decision » change. `attendu` à
 * zéro : aucune décision enregistrée, donc aucune lecture (P12 : le signe vient du fait, jamais l'inverse).
 * Toutes les décisions enregistrées sont rendues, celles de la Salle OMO comprises (§4.12 l.784) : hors de la salle, le serveur
 * n'en écrit aucune, donc le tableau reste celui de l'instance principale.
 */
export function useControlDecisions(rootId: string, attendu: number): { decisions: DecisionView[]; error: string | null; chargement: boolean } {
  const lu = useAsync(async () => (attendu > 0 ? await activityApi.activity(rootId) : null), [rootId, attendu]);
  const decisions = useMemo(() => lu.data?.decisions ?? [], [lu.data]);
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
  /** Salle OMO (§4.14.5) : détections repérées après coup pendant cette demande. Absent ou vide hors de la salle. */
  detections?: readonly JournalDetection[] | undefined;
  /** Salle OMO (D-2b-37) : fichiers signalés et historique git mis de côté. Absent ou vide hors de la salle. */
  quarantaine?: readonly OmoSignale[] | undefined;
}

/** Ligne d'acteur que le Déroulé ne montre pas (fenêtre choisie, bornes du Déroulé) : même nom que le Déroulé lui donnerait. */
const TRAVAIL_DELEGUE = "Travail délégué";

/** Nom d'acteur de la colonne « Qui » : celui que le Déroulé donne à la session ; à défaut, le travail délégué. */
function qui(decision: DecisionView, noms: ReadonlyMap<string, string> | undefined): string {
  return noms?.get(decision.sessionId) ?? TRAVAIL_DELEGUE;
}

/** Titres des blocs de la Salle OMO, sous le tableau (§4.12 l.784). */
const TITRE_DETECTIONS = "Repéré après coup";
const TITRE_QUARANTAINE = "Fichiers mis de côté";

/** Heure d'une détection, à la seconde, comme les lignes du tableau. */
const heureDetection = (at: number) => heureFr.format(at);

/** Blocs de la Salle OMO : détections après coup et fichiers mis de côté. Rien hors de la salle (listes vides). */
function OmoJournalBlocs({ detections, quarantaine }: { detections: readonly JournalDetection[]; quarantaine: readonly OmoSignale[] }) {
  if (detections.length === 0 && quarantaine.length === 0) return null;
  return (
    <div className="stack tight" style={{ marginTop: 10 }}>
      {detections.length > 0 ? (
        <section>
          <h4 className="small">{TITRE_DETECTIONS}</h4>
          <ul className="small">
            {detections.map((detection) => (
              <li key={detection.id}>
                <span className="nowrap">{heureDetection(detection.at)}</span> · {phraseDetectionJournal(detection.cause)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {quarantaine.length > 0 ? (
        <section>
          <h4 className="small">{TITRE_QUARANTAINE}</h4>
          <ul className="small">
            {quarantaine.map((signale) => (
              <li key={`${signale.genre}:${signale.chemin}`}>
                <code>{signale.chemin}</code> · {phraseQuarantaine(signale)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Journal du contrôle (§4.12) : `<table>` (§5.5), texte échappé, état vide quand aucune décision n'a été enregistrée. */
export function ControlJournal({ decisions, advanced, controleIa, noms, chargement, error, vide, detections, quarantaine }: ControlJournalProps) {
  const options: JournalTextOptions = { advanced, controleIa };
  const blocs = <OmoJournalBlocs detections={detections ?? []} quarantaine={quarantaine ?? []} />;
  if (error) return <p className="callout critical small">{error}</p>;
  if (decisions.length === 0) {
    // Des décisions sont enregistrées mais la lecture n'est pas finie : ne jamais dire « aucune décision » à tort (P3).
    return (
      <>
        <p className="small muted">{chargement ? "Lecture du journal…" : (vide ?? JOURNAL.vide)}</p>
        {blocs}
      </>
    );
  }
  return (
    <>
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
                  <span className="journal-mot nowrap">
                    <Icon name={VERDICT_ICONS[decision.verdict]} size={12} />
                    {libelleDecision(decision.verdict)}
                  </span>
                </td>
                <td>{libelleQuiDecide(decision.par)}</td>
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
      {blocs}
    </>
  );
}

/** Repère d'une ligne d'acteur : un verdict, son nombre, et les couples règle/raison à montrer au focus. */
interface Repere {
  verdict: DecisionVerdict;
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
