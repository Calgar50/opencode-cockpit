// Propriétaire : L28c.
// « Revoir » en 2D dans une boîte de dialogue (spécification §5.8 l.998-1002, §5.9 l.1018-1024, §5.5, §5.6 l.928, §2.3 l.102-104 ;
// plan d'exécution it3, fiche L28c, D-3d-11, D-3d-12, D-3d-20, D-3d-29, U2, Q6, décision de l'utilisateur n° 7).
// - NeonBand n'est JAMAIS monté (D-3d-12) : la bande en direct n'est pas remplacée, et rien de sa file d'affichage n'entre ici.
//   Aucune écriture « Affichage rattrapé », aucune lecture oc.messages. La boîte calcule sa vue elle-même, puis la rend par les
//   composants exportés NeonCarte et NeonTableau de la bande.
// - SEULES requêtes de la boîte : GET /api/revoir/:rootId à l'ouverture (salle3dApi.revoir) ; puis, quand l'utilisateur ouvre une
//   consigne, la copie gardée par le cockpit (ConsigneRevoir, L28d, par salle3dApi.revoirConsigne ou revoirConsignesEnfant, U2).
//   Rien n'est relancé, rien n'est facturé : le bandeau le dit.
// - Mode de la scène : « avance » pour une racine de la Salle OMO (toutes les délégations dessinées, décision n° 7), puis
//   vocabulaire du mode Simple par vueSimple (D-3d-20) ; une racine ordinaire garde le mode de l'utilisateur (différé = direct).
// - Lecture seule : aucune saisie, aucun bouton d'autorisation, aucun bouton d'arrêt, aucun envoi. La boîte ne propose que des
//   commandes de lecture.
// - Accessibilité : boîte modale (role="dialog", aria-modal), focus piégé dans la boîte, Échap ferme, focus rendu à l'appelant.
//   Aucune région aria-live : les légendes passent par la région unique de la page (D-3d-29).
// - Salle branchée (« 3s », L3s-a) : rôles des assistants de la salle lus sur la clé de l'agent (roleDeAgent, comme la bande :
//   positions de la carte et noms Simples de vueSimple disent le même rôle) ; « Déroulé partiel : {n} assistants non dessinés »
//   (A36 point 1, spéc. l.356) pour une scène bornée, lu sur la vue montrée (après vueSimple, qui garde `horsBornes`).
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { legendesAuMoment } from "../../../../server/shared/legendes.ts";
import { type NeonScene, scene, visibleCount } from "../../../../server/shared/neon-scene.ts";
import { remplir, TEXTES as NEON } from "../../../../server/shared/neon-texts.ts";
import { roleDeAgent } from "../../../../server/shared/omo-roles.ts";
import { type Demande, demandes, instant } from "../../../../server/shared/revoir.ts";
import { formatHeure, libelleRefus, TEXTES } from "../../../../server/shared/revoir-texts.ts";
import type { RevoirRefus, RevoirResponse } from "../../../../server/shared/salle3d-types.ts";
import { modeSceneRevoir, nomsSimples, vueSimple } from "../../../../server/shared/vue-simple.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { salle3dApi } from "../../../lib/api-salle3d.ts";
import { NeonCarte, NeonTableau } from "../../chat/activity/NeonBand.tsx";
import { DeroulePartiel } from "../DeroulePartiel.tsx";
import type { ConsigneRevoirProps, RevoirDialogProps } from "../slots-3d.ts";
import { ConsigneRevoir } from "./ConsigneRevoir.tsx";
import { LegendeBulle } from "./LegendeBulle.tsx";
import { PanneauRevoir } from "./PanneauRevoir.tsx";
import { ReplayBar } from "./ReplayBar.tsx";
import { useReplay } from "./useReplay.ts";
import "./revoir.css";

const T = TEXTES.partout;
/** Éléments qui peuvent prendre le focus dans la boîte (piège du focus, §5.5). */
const FOCALISABLES = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
/** Décalage du fuseau du poste à appliquer à un instant (l'opposé de getTimezoneOffset, comme l'attend formatHeure). */
const decalageLocal = (ms: number): number => -new Date(ms).getTimezoneOffset();

/**
 * Code de refus porté par une erreur de l'API, lu sur sa forme et non par son type : web/lib/api.ts (donc son client d'opencode)
 * reste hors de revoir/**. Un code inconnu garde une phrase neutre (libelleRefus).
 */
function codeDuRefus(erreur: unknown): string | null {
  const code = erreur !== null && typeof erreur === "object" ? (erreur as { code?: unknown }).code : null;
  return typeof code === "string" && code !== "" ? code : null;
}

export function RevoirDialog(props: RevoirDialogProps) {
  if (!props.ouvert) return null;
  return <Boite {...props} />;
}

function Boite({ rootId, onFermer, demande: demandeVoulue }: RevoirDialogProps) {
  const { advanced } = useApp();
  const titreId = useId();
  const boiteRef = useRef<HTMLDivElement>(null);
  const retourConsigneRef = useRef<HTMLElement | null>(null);
  const consigneRef = useRef<HTMLDivElement>(null);

  const [reponse, setReponse] = useState<RevoirResponse | null>(null);
  const [refus, setRefus] = useState<string | null>(null);
  // Demande demandée par l'appelant, lue à chaque ouverture : la boîte fermée ne monte rien (RevoirDialog rend null).
  const [rang, setRang] = useState<number | null>(demandeVoulue ?? null);
  const [tableau, setTableau] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [consigne, setConsigne] = useState<ConsigneRevoirProps["cible"] | null>(null);

  // Seule requête de la boîte : les faits enregistrés de la conversation (lecture seule, zéro requête à opencode).
  useEffect(() => {
    const abandon = new AbortController();
    setReponse(null);
    setRefus(null);
    salle3dApi
      .revoir(rootId, abandon.signal)
      .then((lue) => setReponse(lue))
      .catch((erreur: unknown) => {
        if (!abandon.signal.aborted) setRefus(codeDuRefus(erreur) ?? "racine-inconnue");
      });
    return () => abandon.abort();
  }, [rootId]);

  // Échap ferme ; Tab reste dans la boîte ; le focus revient à l'appelant à la fermeture (§5.5 : focus jamais volé ni perdu).
  useEffect(() => {
    const appelant = document.activeElement as HTMLElement | null;
    boiteRef.current?.focus();
    return () => appelant?.focus?.();
  }, []);

  const auClavier = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onFermer();
        return;
      }
      if (event.key !== "Tab") return;
      const boite = boiteRef.current;
      if (boite === null) return;
      const cibles = [...boite.querySelectorAll<HTMLElement>(FOCALISABLES)].filter((element) => element.getClientRects().length > 0);
      const premier = cibles[0];
      const dernier = cibles.at(-1);
      if (premier === undefined || dernier === undefined) return;
      const actif = document.activeElement;
      if (!event.shiftKey && actif === dernier) {
        event.preventDefault();
        premier.focus();
      } else if (event.shiftKey && (actif === premier || actif === boite)) {
        event.preventDefault();
        dernier.focus();
      }
    },
    [onFermer],
  );

  const faits = useMemo(() => reponse?.facts ?? [], [reponse]);
  const listeDemandes = useMemo(() => demandes(faits, rootId), [faits, rootId]);
  const choix = rang === null ? listeDemandes.length - 1 : Math.min(Math.max(rang, 0), listeDemandes.length - 1);
  const demande = useMemo<Demande | null>(() => listeDemandes[choix] ?? null, [listeDemandes, choix]);
  const lecteur = useReplay(faits, demande);
  const t = instant(lecteur.etat);

  const salle = reponse?.instance === "omo";
  const simpleSalle = salle && !advanced;
  const zoom = focus === null ? 2 : 3;
  const vue = useMemo<NeonScene>(() => {
    const brute = scene(faits.slice(0, visibleCount(faits, t)), null, { zoom, mode: modeSceneRevoir({ salle, advanced }), focus, roleSalle: roleDeAgent });
    return simpleSalle ? vueSimple(brute, nomsSimples(brute, true)) : brute;
  }, [faits, t, zoom, focus, salle, advanced, simpleSalle]);

  const legendes = useMemo(() => legendesAuMoment(faits, t, { salle }), [faits, t, salle]);
  const ouvrirConsigne = useCallback((cible: ConsigneRevoirProps["cible"], bouton: HTMLElement | null) => {
    retourConsigneRef.current = bouton;
    setConsigne(cible);
  }, []);
  const fermerConsigne = useCallback(() => {
    setConsigne(null);
    retourConsigneRef.current?.focus?.();
    retourConsigneRef.current = null;
  }, []);

  // Le panneau de la consigne prend le focus à son ouverture ; il le rend à [Voir la consigne] à sa fermeture.
  useEffect(() => {
    if (consigne !== null) consigneRef.current?.focus();
  }, [consigne]);

  const surLeFond = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onFermer();
  };

  const moment = lecteur.etat.moments[lecteur.etat.index] ?? null;
  const vide = reponse !== null && refus === null && lecteur.etat.moments.length === 0;
  const lisible = reponse !== null && refus === null && lecteur.etat.moments.length > 0;

  return (
    // Fond d'une boîte modale : le clic à côté ferme, comme Échap (aucune information n'y est portée).
    <div className="revoir-fond" onMouseDown={surLeFond}>
      <div className="revoir-boite" role="dialog" aria-modal="true" aria-labelledby={titreId} ref={boiteRef} tabIndex={-1} onKeyDown={auClavier}>
        <div className="revoir-tete">
          <h2 id={titreId}>{T.revoir}</h2>
          <button type="button" className="btn sm" onClick={onFermer}>
            {T.fermer}
          </button>
        </div>
        <p className="revoir-bandeau">{T.rienRelance}</p>
        {simpleSalle ? <p className="revoir-note">{TEXTES.simple.salle}</p> : null}
        {reponse?.partial === true ? <p className="revoir-note">{T.partiel}</p> : null}
        {/* Scène bornée (A36 point 1) : phrase de la bande, lue sur la vue montrée (vueSimple garde horsBornes). */}
        <DeroulePartiel horsBornes={vue.horsBornes} className="revoir-note" />
        <div className="revoir-corps" aria-busy={reponse === null && refus === null}>
          {refus === null ? null : <p className="revoir-refus">{libelleRefus(refus as RevoirRefus)}</p>}
          {vide ? <p className="revoir-vide">{T.vide}</p> : null}
          {lisible ? (
            <>
              {listeDemandes.length > 1 ? <ChoixDemande demandesLues={listeDemandes} choix={choix} onChoisir={setRang} /> : null}
              <ReplayBar
                index={lecteur.etat.index}
                total={lecteur.etat.moments.length}
                heure={moment}
                vitesse={lecteur.etat.vitesse}
                lecture={lecteur.etat.lecture}
                direct={lecteur.etat.direct}
                raccourciMs={lecteur.raccourciMs}
                suivre={null}
                onLire={lecteur.actions.lire}
                onFiger={lecteur.actions.figer}
                onPrecedent={lecteur.actions.precedent}
                onSuivant={lecteur.actions.suivant}
                onAller={lecteur.actions.aller}
                onVitesse={lecteur.actions.vitesse}
              />
              {vue.detail === null ? (
                <>
                  <button type="button" className="btn sm ghost revoir-tableau" aria-pressed={tableau} onClick={() => setTableau((montre) => !montre)}>
                    {NEON.partout.commandes.tableau}
                  </button>
                  {tableau ? <NeonTableau vue={vue} /> : <NeonCarte vue={vue} onOuvrir={setFocus} />}
                </>
              ) : (
                <PanneauRevoir
                  vue={vue}
                  detail={vue.detail}
                  faits={faits.slice(0, visibleCount(faits, t))}
                  onRetour={() => setFocus(null)}
                  onVoirConsigne={(cible) => ouvrirConsigne(cible, document.activeElement as HTMLElement | null)}
                />
              )}
              <div className="revoir-legendes">
                {legendes.map((legende, i) => {
                  const callId = legende.callId;
                  return (
                    <LegendeBulle
                      key={`${i}:${legende.ancre.genre}:${legende.ancre.id}:${legende.cles.join("+")}`}
                      cles={legende.cles}
                      salle={salle}
                      mode={vue.mode}
                      onVoirConsigne={callId === null ? undefined : () => ouvrirConsigne({ callId }, document.activeElement as HTMLElement | null)}
                    />
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
        {consigne === null ? null : (
          <div className="revoir-consigne-hote" ref={consigneRef} tabIndex={-1}>
            <ConsigneRevoir rootId={rootId} cible={consigne} onFermer={fermerConsigne} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Choix de la demande à revoir : « Demande {n} sur {total} · {heure} » (D-3d-10). */
function ChoixDemande({ demandesLues, choix, onChoisir }: { demandesLues: readonly Demande[]; choix: number; onChoisir: (index: number) => void }) {
  const id = useId();
  return (
    <div className="revoir-demandes">
      <label className="visually-hidden" htmlFor={id}>
        {T.revoir}
      </label>
      <select id={id} className="select sm" value={String(choix)} onChange={(event) => onChoisir(Number(event.currentTarget.value))}>
        {demandesLues.map((une) => (
          <option key={une.debut} value={String(une.index)}>
            {remplir(T.demande, { n: une.index + 1, total: demandesLues.length, heure: formatHeure(une.fait.at, decalageLocal(une.fait.at)) })}
          </option>
        ))}
      </select>
    </div>
  );
}
