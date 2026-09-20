// Propriétaire : L44e.
// Bouton « Seconde lecture (≈ {x} $) » sous une réponse terminée de l'assistant, et pied de la réponse du Relecteur
// (spécification §2.1 l.65 ; conception C §9.7 ; recherche RM §5.4 ; plan d'exécution it5 D-5-06, D-5-22, §4.3 ; A5 ; Q1 (a)).
//
// VOIE PRINCIPALE, tenue par la mesure MC5-1 (train de V0 de 5a, `mesures/MC5.md`, deux passes identiques) : une seconde lecture
// est un message ORDINAIRE envoyé au « Relecteur critique » DANS LA MÊME conversation. Aucune session enfant n'est créée, aucune
// route de repli n'existe, et la phrase « Il voit toute la conversation » est fondée : opencode transmet tout l'historique, les
// parties d'outil comprises. Le composeur GARDE son assistant : rien n'est écrit dans son état.
//
// Honnêteté (P3, D-5-22) : le montant est une ESTIMATION, jamais un minimum — « ≈ », jamais « au moins ». Il est REDEMANDÉ après
// chaque réponse terminée, parce que la conversation s'allonge et que le Relecteur la reçoit entière. La base de l'estimation est
// nommée dans l'infobulle, avec l'IA du Relecteur.
//
// Un seul `prompt_async` par envoi : le cockpit n'ouvre aucun chemin facturé propre (P5). La garde budgétaire de la 1.0 parle la
// première ; sa confirmation est reprise telle quelle.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  secondReadingButtonLabel,
  secondReadingButtonVisible,
  secondReadingMessage,
  secondReadingTooltip,
} from "../../../../server/shared/chat-methods-view.ts";
import { BUDGET_CONFIRM_CANCEL, BUDGET_CONFIRM_SEND, BUDGET_CONFIRM_TITLE } from "../../../../server/shared/assistant-rules.ts";
import { SECOND_READING_CATALOG_ID } from "../../../../server/shared/construction-constants.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { useReloadGuard } from "../../../components/reloadGuard.ts";
import { useToast } from "../../../components/Toast.tsx";
import { Button, useConfirm } from "../../../components/ui.tsx";
import { api, assistantModelChanged, budgetGuard, errorText, oc } from "../../../lib/api.ts";
import { estimateSecondReading } from "../../../lib/api-construction.ts";
import { eventBus } from "../../../lib/events.ts";
import { formatUsd } from "../../../lib/format.ts";
import type { ResolveResponse, SecondReadingEstimate } from "../../../lib/types.ts";
import "./methods-chat.css";

/** Devise ajoutée par `formatUsd` : le gabarit du bouton porte déjà « $ », seul le nombre y entre (§4.3). */
const DEVISE = " $";

/** Nombre formaté à la française, sans sa devise ; null quand rien n'est chiffrable (aucun montant n'est alors affiché). */
function montantSansDevise(usd: number | null): string | null {
  // Un montant que `formatUsd` ne sait pas écrire (valeur non finie) ne devient PAS un libellé bancal : le bouton perd alors
  // sa parenthèse plutôt que d'afficher un chiffre douteux (P3).
  if (usd === null || !Number.isFinite(usd)) return null;
  const texte = formatUsd(usd);
  return texte.endsWith(DEVISE) ? texte.slice(0, -DEVISE.length) : null;
}

// --- Magasin par conversation ----------------------------------------------------------------------------------------------

/**
 * Estimation et occupation d'UNE conversation, partagées par tous les boutons de sa transcription : une seule lecture pour
 * toute la page, plutôt qu'une par tour. `occupee` : une réponse est en cours quelque part dans la conversation — le bouton
 * reste visible sous les réponses déjà terminées, mais il est inactif et dit pourquoi.
 */
interface EtatSecondeLecture {
  estimation: SecondReadingEstimate | null;
  /** Une lecture est faite (même en échec) : avant, le bouton ne s'affiche pas plutôt que d'afficher un montant faux. */
  lue: boolean;
  occupee: boolean;
}

const VIDE: EtatSecondeLecture = Object.freeze({ estimation: null, lue: false, occupee: false });

class MagasinSecondeLecture {
  readonly sessionId: string;
  #etat: EtatSecondeLecture = VIDE;
  #abonnes = new Set<() => void>();
  #stopFlux: (() => void) | null = null;
  #directory = "";
  /** Dernière lecture lancée : seule sa réponse est appliquée (une réponse plus ancienne arrivée après est ignorée). */
  #seq = 0;
  /** Tours dont la réponse n'est pas terminée, signalés par la transcription : source sûre au chargement de la page. */
  #toursEnCours = new Set<string>();
  #occupeeFlux = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get etat(): EtatSecondeLecture {
    return this.#etat;
  }

  abonner(listener: () => void, directory: string): () => void {
    this.#directory = directory;
    this.#abonnes.add(listener);
    this.#ecouter();
    if (!this.#etat.lue && this.#seq === 0) void this.rafraichir();
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
   * `POST /api/chat/second-reading/estimate` : lecture seule, aucune IA appelée. Une erreur laisse l'estimation à null et le
   * bouton disparaît : mieux vaut ne rien proposer que proposer un montant inventé.
   */
  async rafraichir(): Promise<void> {
    if (this.#directory === "") return;
    const seq = ++this.#seq;
    try {
      const estimation = await estimateSecondReading({ directory: this.#directory, sessionId: this.sessionId, cible: "reponse" });
      if (seq === this.#seq) this.#poser({ ...this.#etat, estimation, lue: true });
    } catch (err) {
      if (seq !== this.#seq) return;
      console.warn("seconde lecture : estimation non lue", errorText(err));
      this.#poser({ ...this.#etat, estimation: null, lue: true });
    }
  }

  #occupee(): boolean {
    return this.#occupeeFlux || this.#toursEnCours.size > 0;
  }

  #ecouter(): void {
    this.#stopFlux ??= eventBus.subscribe((event) => {
      if (event.kind === "cockpit") {
        // Flux rétabli : la conversation a pu s'allonger pendant la coupure.
        if (event.type === "stream.reconnected") void this.rafraichir();
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

const MAGASINS = new Map<string, MagasinSecondeLecture>();

function magasinDe(sessionId: string): MagasinSecondeLecture {
  let magasin = MAGASINS.get(sessionId);
  if (!magasin) {
    magasin = new MagasinSecondeLecture(sessionId);
    MAGASINS.set(sessionId, magasin);
  }
  return magasin;
}

/** Estimation et occupation de la conversation, et le tour courant signalé au magasin. */
function useSecondeLecture(sessionId: string, directory: string, cle: string, terminee: boolean): EtatSecondeLecture {
  const magasin = useMemo(() => magasinDe(sessionId), [sessionId]);
  const subscribe = useCallback((listener: () => void) => magasin.abonner(listener, directory), [magasin, directory]);
  const snapshot = useCallback(() => magasin.etat, [magasin]);
  useEffect(() => {
    magasin.signalerTour(cle, terminee);
    return () => magasin.oublierTour(cle);
  }, [magasin, cle, terminee]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// --- Bouton -------------------------------------------------------------------------------------------------------------------

export interface SecondReadingButtonProps {
  sessionId: string;
  /** Clé du tour : elle distingue les réponses d'une même conversation dans le magasin. */
  cle: string;
  /** Assistant dont la réponse serait relue, tel qu'il est nommé dans la transcription. */
  assistant: string;
  terminee: boolean;
  /** Message repère sans appel d'IA : il n'y a rien à relire. */
  repere: boolean;
  /** Cette réponse EST une seconde lecture : on ne relit pas une relecture d'un clic. */
  estSecondeLecture: boolean;
}

export function SecondReadingButton({ sessionId, cle, assistant, terminee, repere, estSecondeLecture }: SecondReadingButtonProps) {
  const { directory } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const guardReload = useReloadGuard();
  const { estimation, lue, occupee } = useSecondeLecture(sessionId, directory, cle, terminee);
  const [envoi, setEnvoi] = useState(false);
  const enVol = useRef(false);

  const visibilite = secondReadingButtonVisible({ terminee, repere, estSecondeLecture });
  const textes = TEXTES.partout.secondeLecture;

  /** Installation du Relecteur par le catalogue existant : aucun chemin d'installation nouveau (C §9.7). */
  const installer = async () => {
    setEnvoi(true);
    try {
      await guardReload((options) => api.installCatalogueAssistant(SECOND_READING_CATALOG_ID, undefined, options));
      await magasinDe(sessionId).rafraichir();
      toast.success("Assistant installé", "Il apparaît maintenant dans le chat.");
    } catch (err) {
      toast.error("Installation impossible", err);
    } finally {
      setEnvoi(false);
    }
  };

  /**
   * Envoi : l'IA est résolue par `POST /api/chat/resolve` pour l'assistant du Relecteur (son IA propre, sinon son niveau —
   * « Rapide » par la réponse Q1 (a)), puis un seul `prompt_async` avec le TEXTE EXACT du §4.3, variante « reponse ».
   * La garde budgétaire de la 1.0 peut refuser : sa confirmation est reprise telle quelle. Un 409 « l'IA de l'assistant a
   * changé » est renvoyé UNE fois avec l'IA annoncée, comme dans le chat.
   */
  const envoyer = async () => {
    const relecteur = estimation?.assistant ?? null;
    if (enVol.current || relecteur === null) return;
    enVol.current = true;
    setEnvoi(true);
    try {
      const texte = secondReadingMessage(assistant);
      let resolu: ResolveResponse;
      try {
        resolu = await api.resolveChat({ directory, agent: relecteur.name });
      } catch (err) {
        toast.error("Envoi impossible", err);
        return;
      }
      const bloquants = resolu.display.problems.filter((probleme) => probleme.blocking);
      if (bloquants.length > 0) {
        toast.error("Rien n'a été envoyé", [...new Set(bloquants.map((probleme) => probleme.message))].join(" "));
        return;
      }
      const corps = (model: ResolveResponse["send"]["model"], variant: string | undefined) => ({
        agent: resolu.agent,
        model,
        ...(variant ? { variant } : {}),
        parts: [{ type: "text", text: texte }],
      });
      const envoyerUneFois = async (confirmed: boolean) => {
        try {
          await oc.promptAsync(sessionId, directory, corps(resolu.send.model, resolu.send.variant), confirmed);
        } catch (err) {
          const change = assistantModelChanged(err);
          if (!change) throw err;
          await oc.promptAsync(sessionId, directory, corps(change.model, change.variant ?? undefined), confirmed);
        }
      };
      try {
        await envoyerUneFois(false);
      } catch (err) {
        const garde = budgetGuard(err);
        if (!garde) throw err;
        // Le titre et la phrase viennent du SERVEUR (budgetConfirmMessage) : ils disent le budget réel, jamais un texte d'ici.
        const ok = await confirm({
          title: garde.title || BUDGET_CONFIRM_TITLE,
          message: garde.message,
          confirmLabel: BUDGET_CONFIRM_SEND,
          cancelLabel: BUDGET_CONFIRM_CANCEL,
          danger: true,
        });
        if (!ok) return;
        await envoyerUneFois(true);
      }
    } catch (err) {
      toast.error("Envoi impossible", err);
    } finally {
      enVol.current = false;
      setEnvoi(false);
    }
  };

  if (!visibilite.visible || !lue || estimation === null) return null;

  // Relecteur absent : la phrase du §4.3 et [Installer], par l'installation du catalogue existante.
  if (!estimation.installe) {
    return (
      <div className="seconde-lecture">
        <span className="seconde-lecture-phrase">{textes.absente}</span>
        <Button size="sm" variant="ghost" icon="plus" loading={envoi} onClick={() => void installer()}>
          Installer
        </Button>
      </div>
    );
  }

  const libelle = secondReadingButtonLabel(montantSansDevise(estimation.usd));
  const infobulle = secondReadingTooltip(estimation);
  return (
    <div className="seconde-lecture">
      <Button
        size="sm"
        variant="ghost"
        icon="eye"
        loading={envoi}
        disabled={occupee}
        title={occupee ? textes.occupee : (infobulle ?? undefined)}
        onClick={() => void envoyer()}
      >
        {libelle}
      </Button>
      {occupee ? <span className="seconde-lecture-phrase">{textes.occupee}</span> : null}
    </div>
  );
}

/** Pied sous la réponse du Relecteur à une seconde lecture : ce qu'elle ne remplace pas (spécification §6, P3). */
export function SecondReadingFooter({ texte }: { texte: string }) {
  return (
    <p className="seconde-lecture-pied" role="note">
      {texte}
    </p>
  );
}
