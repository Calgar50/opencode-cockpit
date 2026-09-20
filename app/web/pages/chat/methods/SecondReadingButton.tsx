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
//
// Avant cet envoi facturé, `secondReadingSendGuard` relit la réponse de la résolution : la route ne refuse pas un assistant
// disparu, elle retombe sur l'assistant par défaut du chat et le dit par `agentMissing`. Sans cette garde, le clic partait à
// l'Assistant général, avec d'autres droits, une autre IA et un autre coût que ceux annoncés par l'infobulle.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  secondReadingButtonLabel,
  secondReadingButtonVisible,
  secondReadingMessage,
  secondReadingSendGuard,
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
import type { ResolveResponse } from "../../../lib/types.ts";
import { type EtatSecondeLecture, creerTableMagasins } from "./second-reading-store.ts";
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
 * Le magasin lui-même vit dans `second-reading-store.ts`, sans React ni réseau : ici, seules la lecture réelle
 * (`estimateSecondReading`) et le flux réel (`eventBus`) lui sont données.
 */
const magasinDe = creerTableMagasins({
  estimer: (directory, sessionId) => estimateSecondReading({ directory, sessionId, cible: "reponse" }),
  abonnerFlux: (ecouter) => eventBus.subscribe(ecouter),
  avertir: (message, detail) => console.warn(message, errorText(detail)),
});

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
      // Dernière garde avant l'envoi facturé : le Relecteur a pu disparaître depuis la lecture de l'estimation. La route
      // retomberait alors sur l'assistant par défaut du chat — un autre assistant, d'autres droits, une autre IA, un autre
      // coût. Rien ne part, et l'estimation est relue pour retrouver [Installer].
      const garde = secondReadingSendGuard({
        relecteur: relecteur.name,
        agent: resolu.agent,
        agentMissing: resolu.agentMissing,
        problemes: resolu.display.problems,
      });
      if (!garde.envoyer) {
        toast.error("Rien n'a été envoyé", garde.message ?? textes.absente);
        if (garde.code === "absent") await magasinDe(sessionId).rafraichir();
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
