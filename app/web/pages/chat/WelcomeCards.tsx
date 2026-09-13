// Accueil d'une nouvelle conversation : « Que voulez-vous faire ? », cartes des assistants (ou du catalogue),
// [+ Créer un assistant] et [Autre demande : Assistant général] (jamais présélectionné).
import type { ReactNode } from "react";
import { BUILTIN_ASSISTANTS, RIGHTS_INFO, TIER_LABELS, USE_CASE_INFO } from "../../../server/shared/assistant-rules.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Badge, Button, Spinner } from "../../components/ui.tsx";
import type { AssistantView, CatalogueItem, RightsLabel } from "../../lib/types.ts";

/** Profil de droits global : null = inconnu (configuration illisible). */
export interface ProfileInfo {
  prudent: boolean;
  label: string;
}

function rightsText(rights: RightsLabel, web: boolean): string {
  return `${RIGHTS_INFO[rights].label}${web ? " · Internet sur demande" : ""}`;
}

function CardHead({ icon, color, title }: { icon: IconName; color: string; title: string }) {
  return (
    <span className="assistant-card-head">
      <span className="assistant-card-icon" style={{ color }}>
        <Icon name={icon} size={16} />
      </span>
      <strong>{title}</strong>
    </span>
  );
}

function AssistantCard({ assistant: a, pressed, onPick }: { assistant: AssistantView; pressed: boolean; onPick: () => void }) {
  const info = a.useCase ? USE_CASE_INFO[a.useCase] : null;
  const ia = a.tier ? TIER_LABELS[a.tier] : (a.modelName ?? "précise");
  return (
    <button type="button" className="assistant-card" aria-pressed={pressed} title={a.description} onClick={onPick}>
      <CardHead icon={a.icon ?? info?.icon ?? "sparkle"} color={info?.color ?? "var(--accent)"} title={a.title} />
      <span className={`small ${a.rights === "personnalise" ? "rights-danger" : "secondary"}`}>{rightsText(a.rights, a.web)}</span>
      <span className="small muted">
        IA {ia}
        {a.estimate ? ` · ${a.estimate.text}` : ""}
      </span>
      {a.state === "ia-indisponible" ? (
        <Badge tone="critical">IA indisponible</Badge>
      ) : a.state === "mise-a-jour" ? (
        <Badge tone="warning">Mise à jour disponible</Badge>
      ) : a.state === "modifie-hors-cockpit" ? (
        <Badge>Modifié hors du cockpit</Badge>
      ) : null}
    </button>
  );
}

function CatalogueCard({ item, installing, onInstall }: { item: CatalogueItem; installing: string | null; onInstall: () => void }) {
  const info = USE_CASE_INFO[item.useCase];
  const unavailable = item.tierStatus === "indisponible";
  return (
    <div className="assistant-card static">
      <CardHead icon={item.icon ?? info.icon} color={info.color} title={item.title} />
      <span className="small secondary clamp-3">{item.description}</span>
      <span className="small">{rightsText(item.rights, item.web)}</span>
      <span className="small muted">
        IA {TIER_LABELS[item.tier]}
        {item.estimate ? ` · ${item.estimate.text}` : ""}
      </span>
      <Badge tone="warning">{item.review}</Badge>
      {unavailable ? <span className="tiny rights-danger">Aucune IA de ce niveau n'est disponible sur votre compte Copilot.</span> : null}
      <Button
        size="sm"
        variant="primary"
        loading={installing === item.id}
        disabled={(installing !== null && installing !== item.id) || (unavailable && !item.installed)}
        onClick={onInstall}
      >
        {item.installed && item.installedName ? "Utiliser" : "Installer et utiliser"}
      </Button>
    </div>
  );
}

export function WelcomeCards({
  projectLabel,
  profile,
  copilotConnected,
  assistants,
  failed,
  catalogue,
  picked,
  installing,
  showGeneral,
  onPick,
  onPickGeneral,
  onInstall,
  onCreate,
  footer,
}: {
  projectLabel: string;
  profile: ProfileInfo | null;
  copilotConnected: boolean;
  /** null : en cours de chargement. */
  assistants: AssistantView[] | null;
  failed: boolean;
  catalogue: CatalogueItem[] | null;
  /** Carte choisie par l'utilisateur dans cet écran (aucune au départ). */
  picked: string | null;
  installing: string | null;
  showGeneral: boolean;
  onPick: (assistant: AssistantView) => void;
  onPickGeneral: () => void;
  onInstall: (item: CatalogueItem) => void;
  onCreate: () => void;
  footer?: ReactNode;
}) {
  const visible = assistants?.filter((a) => a.mode !== "subagent" && !a.hidden) ?? null;
  return (
    <div className="chat-welcome">
      <h2>Que voulez-vous faire ?</h2>
      <p className="secondary">Choisissez un assistant : il connaît sa tâche, ses droits et son IA.</p>
      {profile && !profile.prudent ? (
        <div className="callout warning welcome-text">
          <Icon name="shield" />
          <span>Attention : le profil de droits actuel est « {profile.label} » ; certaines actions se font sans vous demander.</span>
        </div>
      ) : (
        <p className="small secondary welcome-text">
          Projet <strong>{projectLabel}</strong>. L'assistant choisi lit les fichiers de ce dossier. Ce qu'il peut faire en plus est indiqué sur sa
          carte.
        </p>
      )}
      {!copilotConnected ? (
        <div className="callout warning">
          <Icon name="plug" />
          <span>
            GitHub Copilot n'est pas connecté. <a href="#/parametres/connexion">Connecter maintenant</a>
          </span>
        </div>
      ) : null}

      {visible === null ? (
        failed ? (
          <p className="small muted">Liste des assistants indisponible pour le moment.</p>
        ) : (
          <Spinner />
        )
      ) : visible.length > 0 ? (
        <div className="assistant-cards">
          {visible.map((a) => (
            <AssistantCard key={a.name} assistant={a} pressed={picked === a.name} onPick={() => onPick(a)} />
          ))}
        </div>
      ) : catalogue === null ? (
        <Spinner />
      ) : catalogue.length > 0 ? (
        <div className="stack tight welcome-catalogue">
          <h3 className="small muted">Prêts à l'emploi</h3>
          <div className="assistant-cards">
            {catalogue.map((item) => (
              <CatalogueCard key={item.id} item={item} installing={installing} onInstall={() => onInstall(item)} />
            ))}
          </div>
        </div>
      ) : (
        <div className="stack tight">
          <strong>Aucun assistant pour l'instant</strong>
          <span className="small secondary">Installez un assistant prêt à l'emploi ou créez le vôtre en 5 étapes.</span>
        </div>
      )}

      <div className="row wrap welcome-actions">
        <Button icon="plus" onClick={onCreate}>
          Créer un assistant
        </Button>
        {showGeneral ? (
          <Button aria-pressed={picked === "build"} title={BUILTIN_ASSISTANTS.build.help} onClick={onPickGeneral}>
            Autre demande : {BUILTIN_ASSISTANTS.build.title}
          </Button>
        ) : null}
      </div>
      {footer}
    </div>
  );
}
