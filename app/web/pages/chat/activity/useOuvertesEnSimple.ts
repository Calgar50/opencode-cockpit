// Propriétaire : GF5 (grande fusion ; plan it5 §8.6 GF5 point 3, §2.8 ligne DemoPlayer ; U1, D-5-24).
// `ouvertesEnSimple` de GET /api/teams (client api-teams.ts de l'itération 4), lu pour l'appelant du lecteur des démonstrations
// dans la page du chat : DemoPlayer ne lit JAMAIS cette valeur, c'est l'appelant qui calcule equipesOuvertes(mode, …) et passe
// `equipesVisibles`. Lue une fois, À L'AFFICHAGE de la région en mode Simple (jamais pendant une démonstration, qui ne fait
// aucune requête) ; en mode Avancé, rien n'est lu (les équipes y sont toujours ouvertes). `null` tant que la lecture n'a pas
// répondu, ou si elle échoue : fermé en cas de doute (equipesOuvertes rend faux en Simple).
import { useEffect, useState } from "react";
import { teamsApi } from "../../../lib/api-teams.ts";

export function useOuvertesEnSimple(lire: boolean): boolean | null {
  const [valeur, setValeur] = useState<boolean | null>(null);
  useEffect(() => {
    if (!lire) return undefined;
    let vivant = true;
    teamsApi.list().then(
      (reponse) => {
        if (vivant) setValeur(reponse.ouvertesEnSimple === true);
      },
      () => {
        if (vivant) setValeur(null);
      },
    );
    return () => {
      vivant = false;
    };
  }, [lire]);
  return lire ? valeur : null;
}
