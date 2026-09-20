// Scénario e2e de l'itération 2 (paquet L13) : arrêt au plafond de coût, avec un plafond minuscule.
//
// Spécification §4.8.1 (plafond de coût → `stopTree`, autres plafonds → retour à « Demander à chaque fois »), §4.11
// (« Redémarrages » et retours), §4.12 (bandeau et fin de demande), §6 ligne « Arrêt automatique à {x} $ ; un appel en cours peut
// le dépasser » ; plan d'exécution, fiche L13.
//
// Ce que le scénario établit :
//   1. les plafonds de la conversation sont ceux que la confirmation a envoyés (plafond d'arrêt à la borne basse, 0,01 $) ;
//   2. un tour dont le coût dépasse ce plafond arrête l'arbre : la demande est close « plafond-cout » ;
//   3. la conversation revient à « Demander à chaque fois », avec la cause « plafond-cout » : plus rien ne part sans vous ;
//   4. plus aucune session de l'arbre n'est occupée après l'arrêt (§4.8.1, « Arrêter » de L1c).
//
// Honnêteté : ici le coût vient du FAUX opencode, scripté. L'arrêt au plafond sur une IA RÉELLE (où le dépassement possible d'un
// appel en cours se mesure) reste une recette en attente, facturée : elle est consignée pour DOC2.
import {
  activerAutonome,
  atelier,
  attendreFinDeDemande,
  attendreIa,
  attendreQue,
  auRepos,
  avecTemoinP6,
  DOSSIER_ATELIER,
  envoyerEtJouer,
  exiger,
  lireAutonomie,
  nonJoue,
  oc,
  releve,
  resume,
} from "./it2-api-commun.mjs";

/** Borne basse du plafond d'arrêt (CAP_BOUNDS.plafondUsd.min, §4.8.1) : le plus petit plafond que le serveur accepte. */
const PLAFOND_MINUSCULE = 0.01;
/** Coût scripté du tour : bien au-dessus du plafond, pour que la surveillance décide sans ambiguïté. */
const COUT_DU_TOUR = 0.5;

export async function run(ctx) {
  atelier(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "arrêt au plafond de coût", "le coût d'un tour ne se script pas hors du faux opencode");
    return;
  }
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);

  await avecTemoinP6(ctx, async () => {
    const racine = await client.creerConversation("it2-api-plafond");

    // 1. Plafond minuscule, posé par la confirmation.
    const vue = await activerAutonome(ctx, racine.id, { plafondUsd: PLAFOND_MINUSCULE });
    exiger(vue.plafonds.plafondUsd === PLAFOND_MINUSCULE, `plafond d'arrêt posé à ${vue.plafonds.plafondUsd} $ au lieu de ${PLAFOND_MINUSCULE} $.`);

    // 2. Un tour qui coûte plus que le plafond.
    await envoyerEtJouer(ctx, client, racine.id, { text: "Travail coûteux du faux.", cost: COUT_DU_TOUR }, { ia });
    const demande = await attendreFinDeDemande(ctx, racine.id, "plafond-cout");
    exiger(demande.spent >= PLAFOND_MINUSCULE, `demande close « plafond-cout » avec une dépense de ${demande.spent} $.`);
    exiger(demande.plafonds.plafondUsd === PLAFOND_MINUSCULE, `plafonds de la demande : ${resume(demande.plafonds)}`);

    // 3. Retour à « Demander à chaque fois », cause « plafond-cout ».
    const apres = await attendreQue(
      async () => {
        const lue = await lireAutonomie(ctx, racine.id);
        return lue?.choix === "demander" ? lue : false;
      },
      { libelle: "retour à « Demander à chaque fois » après le plafond" },
    );
    exiger(apres.retourCause === "plafond-cout", `cause du retour : ${resume(apres.retourCause)} au lieu de « plafond-cout ».`);
    exiger(apres.demande === null, `une demande autonome est restée ouverte : ${resume(apres.demande)}`);

    // 4. L'arbre est au repos : `stopTree` a bien arrêté ce qui travaillait.
    const enfants = (await client.enfants(racine.id)) ?? [];
    await attendreQue(async () => await auRepos(client, [racine.id, ...enfants.map((e) => e.id)]), { libelle: "arbre au repos après l'arrêt au plafond" });

    releve(
      ctx,
      `plafond d'arrêt ${PLAFOND_MINUSCULE} $ dépassé (${demande.spent} $ relevés) : demande close « plafond-cout », retour à ` +
        "« Demander à chaque fois », arbre au repos. Arrêt au plafond sur IA réelle : recette en attente (facturée).",
    );
  });
}
