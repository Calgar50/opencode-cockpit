// Propriétaire : L44e (corrections de la relecture de 5a V2).
// Magasin de la Seconde lecture d'UNE conversation : estimation lue, occupation de la conversation, et ce qui les périme.
// Module PUR (aucun import React, aucun appel réseau écrit ici) : la lecture et le flux sont DONNÉS à la fabrique, ce qui permet
// de l'éprouver par un test.
//
// Honnêteté (P3, D-5-22) : le montant est REDEMANDÉ après chaque réponse terminée, parce que la conversation s'allonge et que le
// Relecteur la reçoit entière. Deux trous corrigés ici :
// - quand tous les abonnés partent (on quitte la conversation), le flux est LÂCHÉ : les `session.idle` et `session.status` qui
//   passent ensuite ne sont écoutés par personne. Au retour, l'estimation était celle d'avant la longue réponse, et l'occupation
//   pouvait rester bloquée sur sa dernière valeur. La reprise d'abonnement relit donc l'estimation et oublie l'occupation lue au
//   flux, qui n'est plus sûre ;
// - le Relecteur peut disparaître pendant ce temps (supprimé, ou passé en sous-agent). `studio.changed` relit l'estimation, qui
//   repasse alors à `installe: false` : le bouton d'envoi laisse la place à [Installer].
import type { BrowserEvent, SecondReadingEstimate } from "../../../lib/types.ts";

/** Événements du cockpit qui périment l'estimation : le Studio a changé, ou le flux revient après une coupure. */
const RELECTURE: readonly string[] = ["studio.changed", "stream.reconnected"];

/**
 * Estimation et occupation d'UNE conversation, partagées par tous les boutons de sa transcription : une seule lecture pour
 * toute la page, plutôt qu'une par tour. `occupee` : une réponse est en cours quelque part dans la conversation — le bouton
 * reste visible sous les réponses déjà terminées, mais il est inactif et dit pourquoi.
 */
export interface EtatSecondeLecture {
  estimation: SecondReadingEstimate | null;
  /** Une lecture est faite (même en échec) : avant, le bouton ne s'affiche pas plutôt que d'afficher un montant faux. */
  lue: boolean;
  occupee: boolean;
}

export const ETAT_VIDE: EtatSecondeLecture = Object.freeze({ estimation: null, lue: false, occupee: false });

export interface MagasinSecondeLectureOptions {
  /** `POST /api/chat/second-reading/estimate` : lecture seule, aucune IA appelée. */
  estimer: (directory: string, sessionId: string) => Promise<SecondReadingEstimate>;
  abonnerFlux: (ecouter: (event: BrowserEvent) => void) => () => void;
  /** Journal d'une lecture en échec ; `console.warn` en vrai. */
  avertir?: (message: string, detail: unknown) => void;
}

export class MagasinSecondeLecture {
  readonly sessionId: string;
  readonly #options: MagasinSecondeLectureOptions;
  #etat: EtatSecondeLecture = ETAT_VIDE;
  #abonnes = new Set<() => void>();
  #stopFlux: (() => void) | null = null;
  #directory = "";
  /** Dernière lecture lancée : seule sa réponse est appliquée (une réponse plus ancienne arrivée après est ignorée). */
  #seq = 0;
  /** Tours dont la réponse n'est pas terminée, signalés par la transcription : source sûre au chargement de la page. */
  #toursEnCours = new Set<string>();
  #occupeeFlux = false;

  constructor(sessionId: string, options: MagasinSecondeLectureOptions) {
    this.sessionId = sessionId;
    this.#options = options;
  }

  get etat(): EtatSecondeLecture {
    return this.#etat;
  }

  abonner(listener: () => void, directory: string): () => void {
    this.#directory = directory;
    // Le flux avait été lâché alors que le magasin avait déjà lu : des événements ont pu passer sans personne pour les écouter.
    const reprise = this.#stopFlux === null && this.#seq > 0;
    if (reprise) {
      // L'occupation lue au flux n'a plus de source sûre : seuls les tours signalés par la transcription la portent encore.
      this.#occupeeFlux = false;
      this.#poser({ ...this.#etat, occupee: this.#occupee() });
    }
    this.#abonnes.add(listener);
    this.#ecouter();
    if (this.#seq === 0 || reprise) void this.rafraichir();
    return () => {
      this.#abonnes.delete(listener);
      // Plus personne n'écoute : le flux est lâché, mais le magasin reste dans la table. Le retirer ferait naître deux
      // magasins pour une même conversation (double montage de React, puis un bouton par tour), donc deux estimations.
      if (this.#abonnes.size > 0) return;
      this.#stopFlux?.();
      this.#stopFlux = null;
    };
  }

  /** Un tour signale l'état de sa réponse ; la conversation est occupée dès qu'un tour n'est pas terminé. */
  signalerTour(cle: string, terminee: boolean): void {
    const avant = this.#toursEnCours.size;
    if (terminee) this.#toursEnCours.delete(cle);
    else this.#toursEnCours.add(cle);
    if (this.#toursEnCours.size !== avant) this.#poser({ ...this.#etat, occupee: this.#occupee() });
  }

  oublierTour(cle: string): void {
    if (!this.#toursEnCours.delete(cle)) return;
    this.#poser({ ...this.#etat, occupee: this.#occupee() });
  }

  /**
   * Lecture seule, aucune IA appelée. Une erreur laisse l'estimation à null et le bouton disparaît : mieux vaut ne rien
   * proposer que proposer un montant inventé.
   */
  async rafraichir(): Promise<void> {
    if (this.#directory === "") return;
    const seq = ++this.#seq;
    try {
      const estimation = await this.#options.estimer(this.#directory, this.sessionId);
      if (seq === this.#seq) this.#poser({ ...this.#etat, estimation, lue: true });
    } catch (err) {
      if (seq !== this.#seq) return;
      this.#options.avertir?.("seconde lecture : estimation non lue", err);
      this.#poser({ ...this.#etat, estimation: null, lue: true });
    }
  }

  #occupee(): boolean {
    return this.#occupeeFlux || this.#toursEnCours.size > 0;
  }

  #ecouter(): void {
    this.#stopFlux ??= this.#options.abonnerFlux((event) => {
      if (event.kind === "cockpit") {
        // Studio changé (le Relecteur a pu être supprimé ou passer en sous-agent) ou flux rétabli après une coupure.
        if (RELECTURE.includes(event.type)) void this.rafraichir();
        return;
      }
      // Données venues d'opencode : lues avec prudence, jamais supposées.
      const { type, properties } = event.event;
      if (typeof properties.sessionID !== "string" || properties.sessionID !== this.sessionId) return;
      if (type === "session.status") {
        const status = properties.status as { type?: string } | undefined;
        this.#occupeeFlux = status?.type !== "idle";
        this.#poser({ ...this.#etat, occupee: this.#occupee() });
      } else if (type === "session.idle") {
        // Une réponse vient de se terminer : la conversation s'est allongée, l'estimation est redemandée (D-5-22).
        this.#occupeeFlux = false;
        this.#poser({ ...this.#etat, occupee: this.#occupee() });
        void this.rafraichir();
      }
    });
  }

  #poser(etat: EtatSecondeLecture): void {
    if (etat.estimation === this.#etat.estimation && etat.lue === this.#etat.lue && etat.occupee === this.#etat.occupee) return;
    this.#etat = etat;
    for (const abonne of this.#abonnes) abonne();
  }
}

/** Table des magasins, une entrée par conversation ; jamais purgée (voir `abonner`). */
export function creerTableMagasins(options: MagasinSecondeLectureOptions): (sessionId: string) => MagasinSecondeLecture {
  const magasins = new Map<string, MagasinSecondeLecture>();
  return (sessionId: string) => {
    let magasin = magasins.get(sessionId);
    if (!magasin) {
      magasin = new MagasinSecondeLecture(sessionId, options);
      magasins.set(sessionId, magasin);
    }
    return magasin;
  };
}
