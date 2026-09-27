// Propriétaire : L44e.
// Présence de la méthode demandée dans la réponse (spécification §6 l.1051 ; plan d'exécution it5 D-5-08, §4.3) :
// « Méthode appliquée » ou « Méthode non détectée dans la réponse », sous la réponse qui suit une demande avec méthode.
//
// Honnêteté (P3) : le cockpit ne vérifie QUE la présence de la section attendue, jamais la justesse du raisonnement — c'est ce
// que dit l'infobulle, et rien de plus. La réponse de l'IA n'est que lue (texte comparé ligne à ligne par `methodDetected`) :
// elle n'est ni exécutée, ni interprétée, et React échappe ce qui est affiché.
// Accessibilité : le MOT et l'ICÔNE portent l'information ; la couleur ne fait que l'accompagner et disparaît en mode contrasté.
import { methodPresenceRows } from "../../../../server/shared/chat-methods-view.ts";
import type { MethodDemandee } from "../../../../server/shared/chat-methods-view.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useMethodCatalogue } from "./MethodChip.tsx";
import "./methods-chat.css";

export function MethodPresence({ demandees, reponse }: { demandees: readonly MethodDemandee[]; reponse: string }) {
  const catalogue = useMethodCatalogue();
  if (demandees.length === 0) return null;
  const lignes = methodPresenceRows({ demandees, catalogue, reponse });
  if (lignes.length === 0) return null;
  return (
    <>
      {lignes.map((ligne) => (
        <p key={ligne.id} className="methode-presence" data-presente={ligne.presente ? "oui" : "non"} title={ligne.infobulle}>
          <Icon name={ligne.presente ? "checkCircle" : "question"} size={14} />
          <span>{ligne.libelle}</span>
          <span className="visually-hidden">{ligne.infobulle}</span>
        </p>
      ))}
    </>
  );
}
