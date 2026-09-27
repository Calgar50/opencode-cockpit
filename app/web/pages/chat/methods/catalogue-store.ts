// Propriétaire : L44e (corrections de la relecture de 5a V2).
// Magasin du catalogue des méthodes, partagé par la puce, la bulle et la présence d'un message. Module PUR (aucun import React,
// aucun appel réseau écrit ici) : la lecture et le flux sont DONNÉS à la fabrique, ce qui permet de l'éprouver par un test.
//
// `GET /api/methods` est en LECTURE SEULE et rend le même catalogue à toute la page : les trois vues le lisent ici, une seule
// fois, plutôt qu'une fois par tour de conversation. Il est relu quand le Studio change (un bloc ajouté ou retiré d'un fichier
// d'assistant change `utiliseePar`), quand le flux se rétablit, ET à chaque retour dans le chat.
//
// Ce dernier point est la correction : quitter le chat démonte toutes les vues, donc le magasin perd son dernier abonné et
// LÂCHE le flux. Les `studio.changed` qui passent ensuite ne sont écoutés par personne. Sans remise à zéro, le catalogue restait
// celui d'avant : une méthode attachée à l'assistant depuis la page Assistants ne portait pas « Déjà appliquée par
// l'assistant. » au retour, et une méthode retirée restait annoncée comme appliquée.
//
// Une lecture en échec laisse le catalogue VIDE : la puce disparaît et la présence ne dit rien — rien n'est inventé.
import type { BrowserEvent, MethodsResponse, MethodView } from "../../../lib/types.ts";

/** Événements du cockpit qui périment le catalogue. */
const RELECTURE: readonly string[] = ["studio.changed", "stream.reconnected"];

export interface MagasinCatalogue {
  /** Abonnement à la `useSyncExternalStore` : la fonction rendue se désabonne. */
  abonner: (listener: () => void) => () => void;
  /** Instantané stable : la même référence tant que le catalogue n'a pas changé. */
  instantane: () => MethodView[];
}

export interface MagasinCatalogueOptions {
  lire: () => Promise<MethodsResponse>;
  abonnerFlux: (ecouter: (event: BrowserEvent) => void) => () => void;
  /** Journal d'une lecture en échec ; `console.warn` en vrai. */
  avertir?: (message: string, detail: unknown) => void;
}

export function creerMagasinCatalogue(options: MagasinCatalogueOptions): MagasinCatalogue {
  let catalogue: MethodView[] = [];
  let charge = false;
  let enVol: Promise<void> | null = null;
  const abonnes = new Set<() => void>();
  let arreterFlux: (() => void) | null = null;

  const prevenir = () => {
    for (const abonne of abonnes) abonne();
  };

  const lire = (): Promise<void> => {
    enVol ??= options
      .lire()
      .then(
        (reponse) => {
          catalogue = reponse.methods;
        },
        (err: unknown) => {
          catalogue = [];
          options.avertir?.("méthodes : catalogue non lu", err);
        },
      )
      .finally(() => {
        charge = true;
        enVol = null;
        prevenir();
      });
    return enVol;
  };

  const abonner = (listener: () => void): (() => void) => {
    abonnes.add(listener);
    arreterFlux ??= options.abonnerFlux((event) => {
      if (event.kind === "cockpit" && RELECTURE.includes(event.type)) void lire();
    });
    if (!charge && enVol === null) void lire();
    return () => {
      abonnes.delete(listener);
      if (abonnes.size > 0) return;
      arreterFlux?.();
      arreterFlux = null;
      // Plus personne n'écoute le flux : ce qui arrive maintenant est perdu. Le catalogue redevient « non lu », et la garde
      // ci-dessus le relira au prochain abonnement, c'est-à-dire au prochain retour dans le chat.
      charge = false;
    };
  };

  return { abonner, instantane: () => catalogue };
}
