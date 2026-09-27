// Scénario e2e de l'itération 2 (paquet L13) : l'interrupteur `COCKPIT_AUTONOMY` (décision n° 13).
//
// Spécification §4.11 (« Activation refusée … si COCKPIT_AUTONOMY=off : restent « Demander » et « Plan d'abord » »), §4.3
// (pré-conditions du cycle), §4.13 (choix indisponible désactivé avec sa raison) ; plan d'exécution, fiche L13.
//
// UN SEUL SCÉNARIO, DEUX CÔTÉS, choisis par le fichier d'environnement de la pile jetable.
// `docker-compose.yml` sert `COCKPIT_AUTONOMY: ${COCKPIT_AUTONOMY:-on}`. Le banc retire de l'environnement de docker toute
// variable COCKPIT_* du shell (environnementDocker, protection de R105b) : un `COCKPIT_AUTONOMY=off` posé dans le shell ne coupe
// donc RIEN, et le compose sert « on ». Le côté coupé passe par l'option du banc, qui écrit la ligne dans SON fichier :
//   - ALLUMÉ (passage ordinaire du banc) :
//       bash scripts/run-e2e.sh --faux --project-prefix i211-e2e --image-tag i211
//   - COUPÉ (second passage, ce seul scénario) :
//       bash scripts/run-e2e.sh --faux --autonomie-coupee --project-prefix i211-e2e --image-tag i211 \
//         --scenarios it2-api-interrupteur
//     (les autres scénarios it2-* exigent l'autonomie allumée : les lancer dans ce second passage n'aurait pas de sens.)
//
// Côté ALLUMÉ : l'amorçage annonce l'interrupteur allumé, la route d'autonomie rend les QUATRE choix, et un PUT confirmé vers
// « Autonome avec contrôle » passe.
// Côté COUPÉ (décision n° 13) :
//   1. GET /api/bootstrap : `autonomy.interrupteur` vaut false ;
//   2. GET /api/conversations/:rootId/autonomie : « demander » et « plan » restent possibles ; « modifications » et « autonome »
//      indisponibles, chacun avec la raison `autonomie-coupee` et la phrase « Coupé sur ce cockpit par son administrateur :
//      « Demander à chaque fois » et « Plan d'abord » restent possibles. » ;
//   3. PUT …/autonomie {choix: "autonome"}, même confirmé : 403 `autonomie-coupee`, et le choix de la conversation ne bouge pas ;
//   4. POST /api/plans reste permis : « Plan d'abord » ouvre bien une conversation de plan.
import {
  activerAutonome,
  atelier,
  choixFermes,
  DOSSIER_ATELIER,
  exiger,
  exigerListe,
  exigerP6SurRequetes,
  lireAutonomie,
  nonJoue,
  oc,
  putAutonomie,
  releve,
  repereDesRequetes,
  resume,
} from "./it2-api-commun.mjs";

/** Phrase exacte de la raison `autonomie-coupee` (§4.13, autonomy-choice-texts.ts) : c'est la spécification qu'on vérifie. */
export const PHRASE_COUPEE =
  "Coupé sur ce cockpit par son administrateur : « Demander à chaque fois » et « Plan d'abord » restent possibles.";

export async function run(ctx) {
  atelier(ctx);
  // P6 : ce scénario lit la vue d'autonomie et pose des PUT ; aucun flux ouvert n'est nécessaire pour l'établir.
  const depuis = await repereDesRequetes(ctx);
  const bootstrap = await ctx.api.get("/api/bootstrap");
  const interrupteur = bootstrap?.autonomy?.interrupteur;
  exiger(typeof interrupteur === "boolean", `amorçage sans interrupteur d'autonomie : ${resume(bootstrap?.autonomy)}`);

  const client = oc(ctx, DOSSIER_ATELIER);
  const racine = await client.creerConversation("it2-api-interrupteur");
  const vue = await lireAutonomie(ctx, racine.id);
  const disponibles = vue?.disponibles ?? [];
  exigerListe(
    disponibles.map((d) => d.choix),
    ["demander", "modifications", "plan", "autonome"],
    "les quatre choix rendus par le serveur",
  );
  exiger(vue?.interrupteur === interrupteur, `la vue et l'amorçage ne disent pas le même interrupteur (${resume(vue?.interrupteur)}).`);

  if (interrupteur !== true) {
    // Pile montée avec COCKPIT_AUTONOMY=off (--autonomie-coupee) : le scénario devient le contrôle complet de la décision n° 13.
    const coupes = disponibles.filter((d) => d.choix === "modifications" || d.choix === "autonome");
    for (const choix of coupes) {
      exiger(choix.disponible === false, `« ${choix.choix} » disponible alors que l'autonomie est coupée.`);
      exiger(choix.raison === "autonomie-coupee", `« ${choix.choix} » indisponible pour « ${resume(choix.raison)} ».`);
    }
    // « Demander à chaque fois » reste ouvert ; « Plan d'abord » aussi, sa raison `nouvelle-conversation` n'étant pas un refus.
    const restants = choixFermes(vue).filter((d) => d.choix === "demander" || d.choix === "plan");
    exiger(restants.length === 0, `choix fermés alors qu'ils doivent rester possibles : ${resume(restants)}`);
    const refus = await putAutonomie(ctx, racine.id, { choix: "autonome" }, { confirme: true });
    exiger(refus.code === 403, `PUT autonome avec l'autonomie coupée : code ${refus.code} au lieu de 403.`);
    exiger(refus.corps?.error === "autonomie-coupee", `403 sans le code attendu : ${resume(refus.corps)}`);
    exiger(refus.corps?.message === PHRASE_COUPEE, `403 avec une autre phrase : ${resume(refus.corps?.message)}`);
    const apres = await lireAutonomie(ctx, racine.id);
    exiger(apres?.choix === "demander", `le choix a bougé malgré le refus : ${resume(apres?.choix)}`);

    // 4. « Plan d'abord » reste entier : une conversation de plan s'ouvre, et elle porte bien le choix « plan ».
    const plan = await ctx.api.post("/api/plans", { directory: DOSSIER_ATELIER });
    exiger(typeof plan?.rootId === "string", `POST /api/plans refusé alors que « Plan d'abord » doit rester possible : ${resume(plan)}`);
    const vuePlan = await lireAutonomie(ctx, plan.rootId);
    exiger(vuePlan?.choix === "plan", `conversation de plan en « ${resume(vuePlan?.choix)} » au lieu de « plan ».`);

    await exigerP6SurRequetes(ctx, depuis);
    releve(ctx, "COCKPIT_AUTONOMY coupé : seuls « Demander à chaque fois » et « Plan d'abord » restent actifs (403 sur les deux autres)");
    return;
  }

  // Côté allumé : les quatre choix sont actifs et « Autonome avec contrôle » s'active.
  const fermes = choixFermes(vue);
  exiger(fermes.length === 0, `choix fermés alors que l'autonomie est allumée : ${resume(fermes)}`);
  const active = await activerAutonome(ctx, racine.id);
  exiger(active.interrupteur === true, `vue rendue avec l'interrupteur à ${resume(active.interrupteur)}.`);
  nonJoue(
    ctx,
    "COCKPIT_AUTONOMY=off",
    "ce passage sert l'interrupteur allumé ; le côté coupé se joue dans un second passage, « bash scripts/run-e2e.sh " +
      "--faux --autonomie-coupee … --scenarios it2-api-interrupteur » (marche à suivre en tête du scénario)",
  );
  await exigerP6SurRequetes(ctx, depuis);
  releve(ctx, "interrupteur allumé : les quatre choix sont actifs et « Autonome avec contrôle » s'active");
}
