// Carte d'identité d'un assistant (§9.4) : ce qu'il peut faire, IA, coût, fiches, raccourcis et « À savoir ».
// Utilisée par le détail, l'aperçu d'installation et l'aperçu en direct de l'assistant de création.
import { budgetShareText, RIGHT_LINE_SYMBOLS, RIGHTS_INFO, TIER_LABELS, variantLabel } from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Badge, Spinner } from "../../components/ui.tsx";
import type {
  AssistantView,
  BuiltinAssistantView,
  CatalogueItem,
  EstimateView,
  RightLine,
  RightsLabel,
  Tier,
  TierStatus,
  ToCompleteItem,
} from "../../lib/types.ts";
import { TIER_STATUS_TONE } from "./TierCards.tsx";

export interface IdentityData {
  title: string;
  description: string;
  /** Profil de droits (badge), null = non affiché. */
  rights: RightsLabel | null;
  rightLines: RightLine[];
  /** false : lignes calculées depuis le fichier (opencode injoignable). */
  effectiveRules?: boolean;
  model: string | null;
  modelName: string | null;
  tier: Tier | null;
  tierStatus?: TierStatus | null;
  /** Précision après le niveau (ex. « niveau de la conversation »). */
  tierNote?: string | null;
  variant?: string | null;
  estimate: EstimateView | null;
  guardNote: string | null;
  fiches: string[];
  /** Raccourcis qui l'utilisent ; null = ligne masquée (aperçu, catalogue). */
  usedBy: string[] | null;
  /** Bandeau « Exemple à relire avec votre équipe ». */
  review?: string | null;
  examples?: string[];
}

export const KNOW_TEXT =
  "tout ce que vous lui envoyez part chez GitHub Copilot. Ne laissez aucun fichier de clés dans le dossier de travail : la recherche dans les fichiers peut encore en afficher des lignes. Il ne remplace ni la relecture par un collègue ni le CAB.";

export function identityOfView(view: AssistantView, review?: string | null): IdentityData {
  return {
    title: view.title,
    description: view.description,
    rights: view.rights,
    rightLines: view.rightLines,
    effectiveRules: view.effectiveRules,
    model: view.model,
    modelName: view.modelName,
    tier: view.tier,
    variant: view.variant,
    estimate: view.estimate,
    guardNote: view.guardNote,
    fiches: view.fiches,
    usedBy: view.usedBy,
    review: review ?? null,
    examples: view.examples,
  };
}

export function identityOfCatalogue(item: CatalogueItem): IdentityData {
  return {
    title: item.title,
    description: item.description,
    rights: item.rights,
    rightLines: item.rightLines,
    model: item.model,
    modelName: item.modelName,
    tier: item.tier,
    tierStatus: item.tierStatus,
    estimate: item.estimate,
    guardNote: null,
    fiches: item.fiches,
    usedBy: null,
    review: item.review,
    examples: item.examples,
  };
}

export function identityOfBuiltin(item: BuiltinAssistantView): IdentityData {
  return {
    title: item.title,
    description: item.help,
    rights: null,
    rightLines: item.rightLines,
    effectiveRules: item.effectiveRules,
    model: item.model,
    modelName: item.modelName,
    tier: item.tier,
    tierNote: "niveau de la conversation, modifiable dans le chat",
    estimate: item.estimate,
    guardNote: null,
    fiches: [],
    usedBy: null,
  };
}

export function identityOfToComplete(item: ToCompleteItem, title: string): IdentityData {
  return {
    title,
    description: item.description,
    rights: item.rights,
    rightLines: item.rightLines,
    model: item.model,
    modelName: item.modelName,
    tier: item.inferredTier,
    variant: item.variant,
    estimate: null,
    guardNote: null,
    fiches: [],
    usedBy: null,
  };
}

function iaText(data: IdentityData, advanced: boolean): string {
  const name = data.modelName ?? data.model;
  const reflection = data.variant ? ` · ${variantLabel(data.variant, advanced)}` : "";
  if (!name) return data.tier ? `aucune IA disponible pour le niveau ${TIER_LABELS[data.tier]}` : "celle choisie dans le chat";
  if (!data.tier) return `${name} (IA précise)${reflection}`;
  const note = data.tierNote ? ` (${data.tierNote})` : "";
  return `${name} — niveau ${TIER_LABELS[data.tier]}${note}${reflection}`;
}

export function IdentityCard({ data, updating = false, className }: { data: IdentityData; updating?: boolean; className?: string }) {
  const { boot, advanced } = useApp();
  const monthly = boot.settings.budget.monthlyUsd;
  const { estimate } = data;
  const status = data.tierStatus && data.tierStatus !== "ok" ? data.tierStatus : null;

  return (
    <section className={`idc${className ? ` ${className}` : ""}`} aria-busy={updating} aria-label={`Carte d'identité : ${data.title || "nouvel assistant"}`}>
      <header className="idc-head">
        <h3 className="spacer">{data.title.trim() || "Nouvel assistant"}</h3>
        {updating ? <Spinner label="Mise à jour de l'aperçu" /> : null}
        {data.rights ? (
          <Badge tone={data.rights === "personnalise" ? "critical" : "neutral"} title={RIGHTS_INFO[data.rights].help}>
            {RIGHTS_INFO[data.rights].label}
          </Badge>
        ) : null}
      </header>

      {data.review ? (
        <div className="callout warning idc-review">
          <Icon name="alert" size={16} />
          <span>{data.review}</span>
        </div>
      ) : null}

      <p>
        <span className="idc-label">Quand l'utiliser : </span>
        {data.description.trim() || <span className="muted">à préciser</span>}
      </p>

      <div className="stack tight">
        <span className="idc-label">Ce qu'il peut faire</span>
        {data.rightLines.length === 0 ? (
          <span className="small muted">Calcul en cours…</span>
        ) : (
          <ul className="idc-rights">
            {data.rightLines.map((line) => (
              <li key={line.id} className={`idc-line idc-${line.kind}${line.danger ? " danger" : ""}`}>
                <span className="idc-sym" aria-hidden>
                  {RIGHT_LINE_SYMBOLS[line.kind]}
                </span>
                <span>
                  {line.text}
                  {line.danger ? <span className="visually-hidden"> (attention)</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {data.effectiveRules === false ? <span className="tiny muted">Calculé depuis le fichier : opencode ne répond pas pour le moment.</span> : null}
      </div>

      <p>
        <span className="idc-label">IA utilisée : </span>
        {iaText(data, advanced)}
        {status ? (
          <>
            {" "}
            <Badge tone={TIER_STATUS_TONE[status]}>{status === "secours" ? "IA de secours" : status === "indisponible" ? "Indisponible" : "Non vérifié"}</Badge>
          </>
        ) : null}
      </p>

      <div>
        <span className="idc-label">Coût : </span>
        {estimate ? (
          <>
            {estimate.detailText}
            <br />
            <span className="small muted">{budgetShareText(estimate.usd, monthly)}</span>
          </>
        ) : (
          <span className="muted">inconnu (prix de cette IA non renseigné)</span>
        )}
      </div>
      {data.guardNote ? <p className="idc-guard">{data.guardNote}</p> : null}

      <p>
        <span className="idc-label">Fiches consultées : </span>
        {data.fiches.length > 0 ? data.fiches.join(" · ") : "aucune"}
      </p>
      {data.usedBy !== null ? (
        <p>
          <span className="idc-label">Utilisé par les raccourcis : </span>
          {data.usedBy.length > 0 ? data.usedBy.map((name) => `/${name}`).join(" · ") : "aucun"}
        </p>
      ) : null}
      {data.examples && data.examples.length > 0 ? (
        <div className="stack tight">
          <span className="idc-label">Exemples de demandes</span>
          <ul className="idc-examples">
            {data.examples.map((example) => (
              <li key={example}>{example}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="idc-know">
        <strong>À savoir :</strong> {KNOW_TEXT}
      </p>
    </section>
  );
}
