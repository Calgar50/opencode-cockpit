// Propriétaire : L44e.
// Bulle d'un message utilisateur qui portait une méthode (spécification §5.5 ; plan d'exécution it5 D-5-08, §4.3) : le texte
// écrit par la personne est affiché SANS le bloc, et le bloc réellement envoyé est replié sous « Méthode demandée : {titre} ».
// Le bloc est celui du MESSAGE, lu par `splitMessageMethods`, jamais celui du catalogue d'aujourd'hui : la bulle montre ce qui
// est parti, même si la méthode a changé depuis. Texte rendu en clair par React (échappé), jamais en Markdown ni en HTML.
import { methodBubbleRows } from "../../../../server/shared/chat-methods-view.ts";
import type { MethodDemandee } from "../../../../server/shared/chat-methods-view.ts";
import { useMethodCatalogue } from "./MethodChip.tsx";
import "./methods-chat.css";

export function MethodBubble({ methodes }: { methodes: readonly MethodDemandee[] }) {
  const catalogue = useMethodCatalogue();
  if (methodes.length === 0) return null;
  return (
    <>
      {methodBubbleRows(methodes, catalogue).map((ligne) => (
        <details key={ligne.id} className="methode-bulle">
          <summary>{ligne.libelle}</summary>
          <p className="methode-bulle-bloc">{ligne.bloc}</p>
        </details>
      ))}
    </>
  );
}
