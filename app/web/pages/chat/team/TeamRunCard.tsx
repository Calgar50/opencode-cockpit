// Propriétaire : L38b.
// Carte d'UN lancement d'équipe dans le fil (C §9.5) : en-tête « Équipe « {équipe} » · étape {n} sur {N} · {x} $ jusqu'ici ·
// plafond {y} $ » et [Arrêter l'équipe] ; une ligne par étape (icône ET mot, jamais la couleur seule) avec [Voir son travail] qui
// ouvre la session d'étape dans le tiroir de lecture ; bloc de pause (TeamPauseCard) ; cartes finales (arrêtée, plafond, échec,
// interrompue) avec [Relancer la suite (≈ x $)], [Ajouter les résultats obtenus à la conversation] et [Fermer] selon `relancable`
// et `resultatsAjoutes` (D-eq-22).
// Arrêt : boîte « Arrêter l'équipe ? » puis POST …/stop. Relance (D-eq-17, A4) : au clic, POST …/estimate (les lectures se font
// là), puis la boîte « Déjà dépensé : … » et POST …/relancer avec l'EMPREINTE et x-cockpit-confirm: 1 — jamais l'inverse ; un
// refus prévisible (`blocage`) désactive le bouton avec sa raison, sans rien envoyer.
// Annonces : région de la page (L5b, useAnnouncer, réglage ui.activityAnnouncements), polies, jamais une nouvelle région
// aria-live. Modèle et textes : team-view-model.ts (T4t) ; aucune animation, aucun raccourci clavier.
// 5b (L42c) : chaque ligne porte son TOUR (« tour {n} »), le VERDICT d'une relecture en mot et icône, et « ×{n} » quand le bloc
// a travaillé plusieurs tours. Le chemin « aucun ne convient » d'un aiguillage est rendu par la carte de RÉSULTAT, seul endroit
// où l'assistant de repli parvient à l'interface (il est écrit dans le livrable). LE FOCUS N'EST JAMAIS VOLÉ : la carte ne bouge
// aucun focus, et son bloc de pause porte `teamPauseElementId(run.id)` pour qu'un renvoi y mène.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamRunView } from "../../../../server/shared/team-types.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Button, useConfirm } from "../../../components/ui.tsx";
import { useAnnouncer } from "../../../lib/announcer.ts";
import { teamError, teamRunsApi } from "../../../lib/api-teams.ts";
import { errorText } from "../../../lib/api.ts";
import { TeamPauseCard } from "./TeamPauseCard.tsx";
import {
  confirmationArret,
  type RelanceConfirmation,
  relanceApresConfirmation,
  relanceDebut,
  type TeamButton,
  type TeamRunCardModel,
  teamPauseElementId,
} from "./team-view-model.ts";
// <c5:reprise-redemarrage>
import { corpsDeReprise, repriseApresEstimation, repriseDebut } from "./team-view-model.ts";
// </c5:reprise-redemarrage>
// <c5:relance-perimee>
import { confirmationReestimee, relancePerimee } from "./team-view-model.ts";
// </c5:relance-perimee>
// <c5:relance-accords>
import { relanceAvecAccords } from "./team-view-model.ts";
// </c5:relance-accords>
import "./team-cards.css";
import "./team-choice.css";

export interface TeamRunCardProps {
  run: TeamRunView;
  modele: TeamRunCardModel;
  onOpenSession: (sessionId: string) => void;
  /** Une action a changé l'état : le cache relit les lancements de la conversation. */
  onChanged: () => void;
}

const allureBouton = (allure: TeamButton["allure"]) => (allure === "danger" ? "danger" : allure === "primary" ? "primary" : "default");

export function TeamRunCard({ run, modele, onOpenSession, onChanged }: TeamRunCardProps) {
  const { ui } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  const confirm = useConfirm();

  /** Appel en cours (garde synchrone contre un double clic, avant le rendu suivant). */
  const inflight = useRef(false);
  const [occupe, setOccupe] = useState(false);
  /** Raison d'un refus, affichée jusqu'au prochain essai. */
  const [message, setMessage] = useState<string | null>(null);
  /** Refus prévisible de la relance (`blocage` de l'estimation) : le bouton reste désactivé avec sa raison. */
  const [blocage, setBlocage] = useState<string | null>(null);
  /** Carte montée : une réponse arrivée après son démontage ne touche plus à l'état. */
  const monte = useRef(false);
  const dernierEtat = useRef<string | null>(null);

  useEffect(() => {
    monte.current = true;
    return () => {
      monte.current = false;
    };
  }, []);

  // Transition annoncée une fois, poliment, par la région de la page ; jamais le premier état vu.
  useEffect(() => {
    const precedent = dernierEtat.current;
    dernierEtat.current = modele.annonce;
    if (precedent !== null && precedent !== modele.annonce) say(modele.annonce);
  }, [modele.annonce, say]);

  const lancer = useCallback(
    async (action: () => Promise<unknown>) => {
      if (inflight.current) return;
      inflight.current = true;
      setOccupe(true);
      setMessage(null);
      try {
        await action();
        if (monte.current) onChanged();
      } catch (err: unknown) {
        const refus = teamError(err);
        if (monte.current) setMessage(refus === null ? errorText(err) : refus.message);
      } finally {
        inflight.current = false;
        if (monte.current) setOccupe(false);
      }
    },
    [onChanged],
  );

  const arreter = useCallback(() => {
    const boite = confirmationArret();
    void (async () => {
      const ok = await confirm({ title: boite.titre, message: boite.message, confirmLabel: boite.confirmer, cancelLabel: boite.annuler, danger: true });
      if (ok) await lancer(() => teamRunsApi.stop(run.id));
    })();
  }, [confirm, lancer, run.id]);

  // <c5:relance-perimee>
  /**
   * Clôture 5b (contre-vérification) : POST …/relancer après la boîte de confirmation, pour [Relancer la suite] comme pour
   * [Refaire l'estimation de la suite]. `relaunch` est l'appel du bouton, fait avec l'EMPREINTE confirmée. Un 409
   * `estimation-perimee` (boîte restée ouverte plus longtemps que la validité de l'instantané, ou lectures changées) n'affiche
   * plus la phrase du code, fausse ici (« une nouvelle estimation est affichée » : la carte n'affichait rien) : `reestimer` refait
   * l'estimation et la MONTRE dans une nouvelle boîte, une fois par clic (`dejaReestimee`) ; refusée de nouveau, la carte le dit
   * par une phrase vraie (`relancePerimee`). Rien ne part sans votre nouvelle confirmation. Tout autre refus suit le chemin
   * commun de `lancer`, avec sa phrase.
   */
  const relancerAvecEmpreinte = useCallback(
    async (relaunch: () => Promise<unknown>, dejaReestimee: boolean, reestimer: () => void) => {
      let perimee: string | null = null;
      await lancer(async () => {
        try {
          await relaunch();
        } catch (err: unknown) {
          const code = teamError(err)?.error ?? null;
          if (relancePerimee(code, dejaReestimee) === null) throw err;
          perimee = code;
        }
      });
      const suite = relancePerimee(perimee, dejaReestimee);
      if (suite === null || !monte.current) return;
      if (suite.genre === "reestimer") reestimer();
      else setMessage(suite.texte);
    },
    [lancer],
  );
  // </c5:relance-perimee>

  /** D-eq-17 : estimation d'abord (seules lectures), confirmation ensuite, puis `relancer` avec l'empreinte. */
  const relancer = useCallback((dejaReestimee: boolean = false) => {
    if (relanceDebut(run) === null || inflight.current) return;
    inflight.current = true;
    setOccupe(true);
    setMessage(null);
    setBlocage(null);
    void (async () => {
      let confirmation: RelanceConfirmation | null = null;
      try {
        // GF4 (A27) : les accords que l'estimation annonce (budget du mois, plafond maximum) sont écrits dans la boîte.
        const etape = relanceAvecAccords(await teamRunsApi.estimate(run.id));
        if (etape.genre === "blocage") {
          if (monte.current) setBlocage(etape.raison);
        } else if (etape.genre === "confirmation") {
          confirmation = dejaReestimee ? confirmationReestimee(etape.confirmation) : etape.confirmation;
        }
      } catch (err: unknown) {
        const refus = teamError(err);
        if (monte.current) setMessage(refus === null ? errorText(err) : refus.message);
      } finally {
        inflight.current = false;
        if (monte.current) setOccupe(false);
      }
      if (confirmation === null) return;
      const ok = await confirm({ title: confirmation.titre, message: confirmation.message });
      const suite = relanceApresConfirmation(confirmation, ok);
      if (suite === null) return;
      // GF4 (A27) : l'empreinte confirmée, et les accords que la boîte vient d'écrire — jamais d'autres (sans accord, le corps de
      // l'itération 4).
      const corps = corpsDeReprise(suite, confirmation);
      await relancerAvecEmpreinte(() => teamRunsApi.relaunch(run.id, corps), dejaReestimee, () => relancer(true));
    })();
  }, [confirm, relancerAvecEmpreinte, run]);

  // <c5:reprise-redemarrage>
  /**
   * Clôture 5b (D-5b-1) : [Refaire l'estimation de la suite] d'une pause reprise après un redémarrage du cockpit. Même suite que
   * la relance (D-eq-17, A4) : POST …/estimate d'abord (seules lectures), la boîte « Reprendre avec cette estimation ? » ensuite,
   * puis POST …/relancer avec l'EMPREINTE et x-cockpit-confirm: 1. Un refus prévisible (`blocage`) est dit, rien n'est envoyé.
   * Tour 3 : les accords que l'estimation annonce (budget du mois, plafond maximum) sont écrits dans la boîte, et envoyés avec
   * l'empreinte seulement quand la boîte les a écrits (`corpsDeReprise`).
   * Après la confirmation, la carte relit le lancement : la pause revient sans demande d'estimation, et c'est votre réponse qui
   * la fait repartir — sauf la pause « Le cockpit a redémarré », que la confirmation relance.
   * `dejaReestimee` : estimation refaite après un 409 `estimation-perimee` (relancerAvecEmpreinte) ; le bouton passe toujours
   * `false` par `reprendre`, jamais l'événement du clic.
   */
  const reprendreEstimation = useCallback((dejaReestimee: boolean) => {
    const pause = run.pause;
    // Tour 3 : sans bouton au modèle (équipes fermées dans le mode courant, U1, ou demande perdue), aucune estimation n'est demandée.
    if (pause === null || repriseDebut(run) === null || (modele.pause?.reprise?.bouton ?? null) === null || inflight.current) return;
    inflight.current = true;
    setOccupe(true);
    setMessage(null);
    void (async () => {
      let confirmation: RelanceConfirmation | null = null;
      try {
        const etape = repriseApresEstimation(pause, await teamRunsApi.estimate(run.id));
        if (etape.genre === "blocage") {
          if (monte.current) setMessage(etape.raison);
        } else if (etape.genre === "confirmation") {
          confirmation = dejaReestimee ? confirmationReestimee(etape.confirmation) : etape.confirmation;
        }
      } catch (err: unknown) {
        const refus = teamError(err);
        if (monte.current) setMessage(refus === null ? errorText(err) : refus.message);
      } finally {
        inflight.current = false;
        if (monte.current) setOccupe(false);
      }
      if (confirmation === null) return;
      const ok = await confirm({ title: confirmation.titre, message: confirmation.message });
      const suite = relanceApresConfirmation(confirmation, ok);
      if (suite === null) return;
      // Tour 3 : l'empreinte confirmée, et les accords (budget, plafond) que la boîte vient d'écrire — jamais d'autres.
      const corps = corpsDeReprise(suite, confirmation);
      await relancerAvecEmpreinte(() => teamRunsApi.relaunch(run.id, corps), dejaReestimee, () => reprendreEstimation(true));
    })();
  }, [confirm, relancerAvecEmpreinte, run, modele.pause?.reprise?.bouton]);
  const reprendre = useCallback(() => reprendreEstimation(false), [reprendreEstimation]);
  // </c5:reprise-redemarrage>

  const cliquer = useCallback(
    (bouton: TeamButton, desactive: boolean) => {
      if (desactive) return;
      switch (bouton.action) {
        case "arreter":
          arreter();
          return;
        case "relancer":
          relancer();
          return;
        case "ajouter-resultats":
        case "ajouter":
          void lancer(() => teamRunsApi.addResults(run.id));
          return;
        case "fermer":
          void lancer(() => teamRunsApi.close(run.id));
          return;
        default:
          return;
      }
    },
    [arreter, lancer, relancer, run.id],
  );

  const continuer = useCallback(
    (corps: { precision?: string; correction?: string; choix?: string[]; aucun?: true }, confirme: boolean) => {
      void lancer(() => teamRunsApi.continue(run.id, corps, confirme ? { confirm: true } : {}));
    },
    [lancer, run.id],
  );

  /** Raison lue à côté du bouton : le refus prévisible de la relance remplace la raison du modèle. */
  const raisonDe = (bouton: TeamButton) => (bouton.action === "relancer" && blocage !== null ? blocage : bouton.raison);

  return (
    <section className={`team-card team-run state-${run.state}`} aria-label={modele.entete}>
      <div className="team-card-head">
        <Icon name={modele.etatIcone} className="team-icon" />
        <p className="team-card-title tabular">{modele.entete}</p>
        <span className="team-card-state">{modele.etatMot}</span>
      </div>
      {modele.message === null ? null : <p className="team-card-message">{modele.message}</p>}
      {modele.bilan === null ? null : <p className="team-card-note tabular">{modele.bilan}</p>}
      {modele.lignes.length === 0 ? null : (
        <ul className="team-steps">
          {modele.lignes.map((ligne) => (
            <li key={ligne.cle} className={`team-step kind-${ligne.kind}`}>
              <Icon name={ligne.icone} className="team-icon" />
              <span className="team-step-main">
                <span className="team-step-detail">{ligne.detail === "" ? ligne.titre : ligne.detail}</span>
                <span className="team-step-state">{ligne.mot}</span>
                {ligne.tour === null ? null : <span className="team-step-note">{ligne.tour}</span>}
                {ligne.repetition === null ? null : <span className="team-step-note tabular">{ligne.repetition}</span>}
                {ligne.verdict === null ? null : (
                  <span className="team-step-verdict">
                    <Icon name={ligne.verdict.icone} className="team-icon" />
                    {ligne.verdict.mot}
                  </span>
                )}
                {ligne.tentative === null ? null : <span className="team-step-note">{ligne.tentative}</span>}
                {ligne.tronquee === null ? null : <span className="team-step-note">{ligne.tronquee}</span>}
                {ligne.cause === null ? null : <span className="team-step-note">{ligne.cause}</span>}
              </span>
              {ligne.sessionId === null || ligne.voirTravail === null ? null : (
                <Button size="sm" onClick={() => onOpenSession(ligne.sessionId ?? "")}>
                  {ligne.voirTravail}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* <c5:reprise-redemarrage> */}
      {modele.pause === null ? null : (
        <TeamPauseCard
          pause={modele.pause}
          blocId={teamPauseElementId(modele.runId)}
          occupe={occupe}
          onContinue={continuer}
          onStop={arreter}
          onReprendre={reprendre}
        />
      )}
      {/* </c5:reprise-redemarrage> */}
      {modele.boutons.length === 0 ? null : (
        <div className="team-card-actions">
          {modele.boutons.map((bouton) => {
            const desactive = bouton.desactive || (bouton.action === "relancer" && blocage !== null);
            return (
              <Button
                key={bouton.action}
                variant={allureBouton(bouton.allure)}
                disabled={occupe}
                aria-disabled={desactive}
                aria-describedby={raisonDe(bouton) === null ? undefined : `${modele.runId}-${bouton.action}`}
                onClick={() => cliquer(bouton, desactive)}
              >
                {bouton.libelle}
              </Button>
            );
          })}
        </div>
      )}
      {modele.boutons.map((bouton) => {
        const raison = raisonDe(bouton);
        return raison === null ? null : (
          <p key={bouton.action} id={`${modele.runId}-${bouton.action}`} className="team-card-note">
            {raison}
          </p>
        );
      })}
      {message === null ? null : <p className="team-card-message">{message}</p>}
    </section>
  );
}
