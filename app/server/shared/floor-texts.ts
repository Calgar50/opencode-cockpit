// Textes du plancher de conversation (spécification §3.4, D-04) : refus 502 « plancher-non-verifie » du proxy, contrôlés par
// textes.test.ts. Honnêteté (§6, P3), chaque phrase tenue par session-floor-service.test.ts :
// - « Aucun message n'a été envoyé ni facturé » (création) : seule la création a été demandée à opencode, aucun message ;
// - « Rien n'a été facturé » (envoi) : un envoi refusé n'est jamais relayé à opencode (aucune requête d'envoi reçue par le faux) ;
// - « non créée » seulement quand la suppression a réussi ; sinon la conversation peut rester, et tout message y est refusé tant
//   que ses protections ne sont pas vérifiées (vérification refaite avant chaque envoi) ;
// - une conversation existante n'est jamais supprimée pour un écart : « Message non envoyé » ;
// - « Réessayez dans un instant » seulement quand opencode n'a pas pu répondre ; un écart vérifié se répète à chaque envoi :
//   « Continuez dans une nouvelle conversation ».
export const TEXTES = {
  simple: {},
  avance: {},
  partout: {
    creationRefusee:
      "Conversation non créée : le cockpit n'a pas pu vérifier ses protections, dont le refus de lire les fichiers de clés. Aucun message n'a été envoyé ni facturé.",
    creationRefuseeRestee:
      "Conversation refusée : le cockpit n'a pas pu vérifier ses protections, dont le refus de lire les fichiers de clés, ni la retirer de la liste. Aucun message n'y a été envoyé ni facturé, et elle refusera vos messages tant que ses protections ne seront pas vérifiées.",
    envoiRefuse:
      "Message non envoyé : le cockpit n'a pas pu vérifier les protections de cette conversation, dont le refus de lire les fichiers de clés. Rien n'a été facturé. Réessayez dans un instant.",
    envoiRefuseEcart:
      "Message non envoyé : le cockpit ne peut pas vérifier les protections de cette conversation, dont le refus de lire les fichiers de clés. Rien n'a été facturé. Continuez dans une nouvelle conversation.",
  },
} as const;

/**
 * Refus du plancher : création refusée (conversation supprimée, ou restée faute de suppression) ; envoi refusé parce qu'opencode
 * n'a pas répondu (« envoi ») ou parce que la conversation ne tient pas le plancher (« envoi-ecart »).
 */
export type FloorRefusal = "creation" | "creation-restee" | "envoi" | "envoi-ecart";

export function floorRefusalText(refusal: FloorRefusal): string {
  switch (refusal) {
    case "creation":
      return TEXTES.partout.creationRefusee;
    case "creation-restee":
      return TEXTES.partout.creationRefuseeRestee;
    case "envoi":
      return TEXTES.partout.envoiRefuse;
    case "envoi-ecart":
      return TEXTES.partout.envoiRefuseEcart;
  }
}
