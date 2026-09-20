// Propriétaire : L1f.
// Carte détaillée d'une délégation en mode Avancé, dans la demande d'autorisation `task` (spécification §3.14 « Avancé », §4.10
// « @chemin dans une consigne déléguée » ; plan d'exécution, fiche L1f) : assistant demandé, IA du travail délégué, estimation,
// compteurs de la demande, droits comparés de l'assistant qui délègue et de l'assistant demandé, « tout @fichier est lu sans vous
// demander », et le refus que la garde (L1d) opposerait à « Autoriser une fois ». Données : GET
// /api/conversations/:rootId/delegations/:permissionId (L1d), lues à l'ouverture et à [Réessayer] ; 404 : demande plus en attente.
// Textes venus d'opencode, du Studio ou d'une IA (nom et titre de l'assistant, IA) : rendus en TEXTE par React (échappés, jamais du
// HTML ni du Markdown), séquences de terminal et caractères cachés retirés, longueur bornée (boundedAiText). La phrase « @fichier »
// reste affichée même quand les détails ne se lisent pas (elle ne dépend pas de la demande).
// Mode Simple : rien (la délégation y est refusée d'office ; avis DelegationNotice). Propriétés figées dans ../slots.ts.
import { useEffect, useId, useState } from "react";
import {
  libelleAction,
  libelleCible,
  libelleDroit,
  libelleIa,
  phraseCompteurs,
  phraseEstimation,
  phraseRefusPrevu,
  TEXTES,
} from "../../../../server/shared/delegation-texts.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Button, Spinner } from "../../../components/ui.tsx";
import { ApiError } from "../../../lib/api.ts";
import { conversationApi } from "../../../lib/api-conversations.ts";
import type { DelegationDetailsView } from "../../../lib/types.ts";
import type { DelegationDetailsProps } from "../slots.ts";
import { boundedAiText } from "../turn.ts";
import "./delegation.css";

/** Nom et titre d'assistant affichés au plus (valeurs venues d'opencode ou du Studio). */
const NAME_MAX = 64;
/** Identifiant d'IA affiché au plus (« fournisseur/IA »). */
const MODEL_MAX = 128;

type Load =
  | { etat: "chargement" }
  | { etat: "pret"; view: DelegationDetailsView }
  | { etat: "erreur"; texte: string; reessayer: boolean };

/** 404 : la demande n'est plus en attente (rien à relire) ; 503 : opencode ne répond pas ; autre : indisponible, à relire. */
function failure(err: unknown): Load {
  const c = TEXTES.avance.carte;
  if (err instanceof ApiError && err.status === 404) return { etat: "erreur", texte: c.plusEnAttente, reessayer: false };
  if (err instanceof ApiError && err.status === 503) return { etat: "erreur", texte: c.illisible, reessayer: true };
  return { etat: "erreur", texte: c.indisponible, reessayer: true };
}

const bounded = (value: unknown, max: number): string => boundedAiText(value, max).text.trim();

export function DelegationDetails({ rootId, permissionId, advanced }: DelegationDetailsProps) {
  if (!advanced) return null;
  // Une instance par demande : les détails d'une demande ne passent jamais à la suivante.
  return <Details key={`${rootId}/${permissionId}`} rootId={rootId} permissionId={permissionId} />;
}

function Details({ rootId, permissionId }: { rootId: string; permissionId: string }) {
  const c = TEXTES.avance.carte;
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ etat: "chargement" });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ etat: "chargement" });
    conversationApi.delegationDetails(rootId, permissionId, controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setLoad({ etat: "pret", view });
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setLoad(failure(err));
      },
    );
    return () => controller.abort();
  }, [rootId, permissionId, attempt]);

  return (
    <section className="delegation-details" aria-labelledby={titleId}>
      <h4 id={titleId} className="delegation-details-title">
        <Icon name="users" size={14} />
        {c.titre}
      </h4>
      {load.etat === "chargement" ? (
        <p className="delegation-details-status">
          <Spinner label={c.chargement} />
          {c.chargement}
        </p>
      ) : null}
      {load.etat === "erreur" ? (
        <p className="delegation-details-status">
          <span>{load.texte}</span>
          {load.reessayer ? (
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
              {c.reessayer}
            </Button>
          ) : null}
        </p>
      ) : null}
      {load.etat === "pret" ? <Facts view={load.view} /> : null}
      <p className="delegation-details-warning">
        <Icon name="alert" size={14} />
        <span>{c.arobase}</span>
      </p>
    </section>
  );
}

function Facts({ view }: { view: DelegationDetailsView }) {
  const c = TEXTES.avance.carte;
  const cible =
    view.cible === null
      ? null
      : { ...view.cible, nom: bounded(view.cible.nom, NAME_MAX), titre: bounded(view.cible.titre, NAME_MAX), mode: bounded(view.cible.mode, NAME_MAX) };
  const ia = { model: view.ia.model === null ? null : bounded(view.ia.model, MODEL_MAX) || null, disponible: view.ia.disponible === true };
  const droits = Array.isArray(view.droits) ? view.droits : [];
  return (
    <>
      <dl className="delegation-details-facts">
        <dt>{c.cible}</dt>
        <dd>{libelleCible(cible)}</dd>
        <dt>{c.ia}</dt>
        <dd>{libelleIa(ia)}</dd>
        <dt>{c.estimation}</dt>
        <dd>{phraseEstimation(view.estimationUsd)}</dd>
        <dt>{c.compteurs}</dt>
        <dd>{phraseCompteurs(view.compteurs)}</dd>
      </dl>
      {droits.length > 0 ? (
        <div className="delegation-details-rights">
          <table>
            <caption>{c.droits}</caption>
            <thead>
              <tr>
                <th scope="col">{c.colonneDroit}</th>
                <th scope="col">{c.colonneAppelant}</th>
                <th scope="col">{c.colonneCible}</th>
              </tr>
            </thead>
            <tbody>
              {droits.map((droit) => (
                <tr key={droit.permission}>
                  <th scope="row">{libelleDroit(droit.permission)}</th>
                  <td className={droit.appelant ?? "inconnu"}>{libelleAction(droit.appelant)}</td>
                  <td className={droit.cible ?? "inconnu"}>{libelleAction(droit.cible)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="delegation-details-note">{c.droitsNote}</p>
      {view.refus !== null ? (
        <p className="callout critical small delegation-details-refus" role="note">
          <Icon name="ban" size={14} />
          <span>{phraseRefusPrevu(view.refus)}</span>
        </p>
      ) : null}
    </>
  );
}
