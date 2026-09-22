// Propriétaire : L26a.
// Tableau « sans demande » (spécification §6, bouton [Ce que l'extension fait sans demande] du §4.14.6) : ce que l'extension
// Oh My OpenAgent enchaîne seule, ce que le cockpit refuse et ce qu'il ne constate qu'après coup.
// - une phrase par ligne, toutes de T3a (`honnetete`), assemblées par le modèle pur shared/omo-activation-view.ts : les
//   formulations sont DISTINCTES de celles de l'écran d'activation, et aucune n'est réécrite ici ;
// - <table> avec une légende (§5.5) ; aucune animation.
import { vueSansDemande } from "../../../server/shared/omo-activation-view.ts";

export interface SansDemandeTableProps {
  /** Date d'audit de l'extension. */
  dateAudit: string;
  /** Montant d'arrêt saisi, tel quel ; null : aucune demande confirmée. */
  plafondSaisi: string | null;
}

export function SansDemandeTable({ dateAudit, plafondSaisi }: SansDemandeTableProps) {
  const lignes = vueSansDemande({ plafondSaisi, dateAudit });
  return (
    <table className="omo-sans-demande">
      <caption className="small muted">Ce que l'extension fait sans demande</caption>
      <tbody>
        {lignes.map((ligne) => (
          <tr key={ligne}>
            <td>{ligne}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
