// Propriétaire : L28c.
// Détail d'un assistant pendant « Revoir » (spécification §5.7.4, §5.9 l.1018-1024 ; plan d'exécution it3, fiche L28c, D-3d-12,
// D-3d-30, U2). Remplace le panneau du zoom 3 de la bande (NeonZoom3), qui relit les messages dans la conversation : ici, RIEN
// n'est relu.
// - Source unique : `vue.detail` (NeonDetail), donc des faits enregistrés (P12) : outils comptés, dossiers et tuiles avec leurs
//   états, états de la consigne, du résultat et de la réponse. Aucun nom de fichier : la clé d'un fichier (pathKey) n'est pas un
//   chemin, et le chemin ne se relit que dans les messages, jamais pendant « Revoir ».
// - À la place de TOUT texte de message : revoir-texts.partout.texteNonAffiche.
// - SEULE exception (U2) : la consigne reçue, dont le cockpit garde une copie bornée et masquée. [Voir la consigne] ouvre
//   ConsigneRevoir (L28d) sur le callId du fait `consigne` qui désigne la session affichée ; une session sans fait `consigne`
//   qui la désigne et qui n'est pas la racine (étape d'équipe après la grande fusion, D-3d-30) est demandée par `enfant`.
//   Aucune requête n'est faite ici : ConsigneRevoir n'est ouvert qu'à la demande, et c'est lui qui lit la copie gardée.
import type { ActivityFact } from "../../../../server/shared/activity-types.ts";
import { TEXTES as LEGENDES } from "../../../../server/shared/legendes-texts.ts";
import { libelleNoeud } from "../../../../server/shared/neon-band.ts";
import type { NeonDetail, NeonScene, NeonTile } from "../../../../server/shared/neon-scene.ts";
import { libelleEtat, libelleOutil, remplir, TEXTES as NEON } from "../../../../server/shared/neon-texts.ts";
import { TEXTES } from "../../../../server/shared/revoir-texts.ts";
import type { ConsigneRevoirProps } from "../slots-3d.ts";
import "./revoir.css";

/** Valeur absente ou sans état : un tiret, comme le panneau du zoom 3 de la bande (aucun texte inventé). */
const RIEN = "—";

export interface PanneauRevoirProps {
  vue: NeonScene;
  detail: NeonDetail;
  /** Faits montrés au moment courant : seule source du callId de la consigne reçue (P12). */
  faits: readonly ActivityFact[];
  /** Retour à la carte. */
  onRetour(): void;
  /** [Voir la consigne] : ouvre ConsigneRevoir dans la boîte (U2) ; absent, le bouton n'est pas proposé. */
  onVoirConsigne?(cible: ConsigneRevoirProps["cible"]): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const texte = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * Cible de [Voir la consigne] pour la session affichée (D-3d-30) : le callId du DERNIER fait `consigne envoyee` qui la désigne
 * comme enfant ; à défaut, et si ce n'est pas la racine (étape d'équipe, sans partie `task` ni callId), toutes les consignes
 * gardées de cette session. La racine n'a reçu aucune consigne : null, aucun bouton.
 */
function cibleConsigne(faits: readonly ActivityFact[], sessionId: string, racine: boolean): ConsigneRevoirProps["cible"] | null {
  for (let i = faits.length - 1; i >= 0; i--) {
    const fait = faits[i];
    if (fait?.kind !== "consigne" || !isRecord(fait.data)) continue;
    if (fait.data.etat !== "envoyee" || fait.data.enfant !== sessionId) continue;
    const callId = texte(fait.data.callId) ?? texte(fait.ref);
    if (callId !== null) return { callId };
  }
  return racine ? null : { enfant: sessionId };
}

/** États d'une tuile de fichier, en toutes lettres (neon-texts) ; un tiret quand aucun état n'est posé. */
function etatsTuile(tuile: NeonTile): string {
  const etats = [tuile.lu ? NEON.partout.tuiles.lu : "", tuile.modifie ? NEON.partout.tuiles.modifie : "", tuile.refuse ? NEON.partout.tuiles.refuse : "", tuile.enCours ? NEON.partout.tuiles.enCours : ""];
  const poses = etats.filter((mot) => mot !== "");
  return poses.length === 0 ? RIEN : poses.join(", ");
}

/** État montré à la place du texte du résultat ou de la réponse : jamais le texte lui-même (D-3d-12). */
function etatDuRetour(resultat: NeonDetail["panneau"]["resultat"]): string {
  if (resultat === null || resultat.etat === "rendu") return TEXTES.partout.texteNonAffiche;
  return libelleEtat(resultat.etat === "echec" ? "echec" : "arrete");
}

export function PanneauRevoir({ vue, detail, faits, onRetour, onVoirConsigne }: PanneauRevoirProps) {
  const noeud = vue.noeuds.find((n) => n.sessionId === detail.sessionId);
  const racine = noeud?.role === "conversation";
  const { panneau } = detail;
  const cible = cibleConsigne(faits, detail.sessionId, racine);
  const outils = [...detail.outils.map((o) => ({ nom: libelleOutil(o.categorie), ...o })), { nom: libelleOutil("autres"), ...detail.autresOutils }]
    .map((o) => ({ nom: o.nom, total: o.enCours + o.termines + o.echecs + o.interrompus }))
    .filter((o) => o.total > 0);
  const tuiles = detail.dossiers.flatMap((dossier) => dossier.tuiles);
  const enPlus = detail.dossiers.reduce((somme, dossier) => somme + dossier.enPlus, 0) + detail.dossiersEnPlus;

  return (
    <div className="revoir-panneau">
      <div className="revoir-panneau-tete">
        <p>{noeud === undefined ? NEON.partout.assistantConversation : libelleNoeud(noeud)}</p>
        <button type="button" className="btn sm" onClick={onRetour}>
          {NEON.partout.commandes.afficher}
        </button>
      </div>
      <dl>
        <dt>{TEXTES.partout.consigne.titre}</dt>
        <dd>
          <p className="revoir-panneau-texte">{TEXTES.partout.texteNonAffiche}</p>
          {cible === null || onVoirConsigne === undefined ? null : (
            <button type="button" className="btn sm ghost" onClick={() => onVoirConsigne(cible)}>
              {LEGENDES.partout.voirConsigne}
            </button>
          )}
        </dd>
        <dt>{NEON.partout.panneau.actions}</dt>
        <dd>
          {outils.length === 0 && tuiles.length === 0 ? (
            <p className="revoir-panneau-texte">{RIEN}</p>
          ) : (
            <ul>
              {outils.map((outil) => (
                <li key={outil.nom}>{`${outil.nom} : ${outil.total}`}</li>
              ))}
              {tuiles.map((tuile) => (
                <li key={`${tuile.fichier}|${tuile.callId}`}>{etatsTuile(tuile)}</li>
              ))}
              {enPlus > 0 ? <li>{remplir(NEON.partout.tuiles.enPlus, { n: enPlus })}</li> : null}
            </ul>
          )}
        </dd>
        {panneau.resultat === null && panneau.reponse === null ? null : (
          <>
            <dt>{panneau.resultat === null ? NEON.partout.panneau.reponse : NEON.partout.panneau.resultat}</dt>
            <dd>
              <p className="revoir-panneau-texte">{etatDuRetour(panneau.resultat)}</p>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
