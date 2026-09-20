// Scénario e2e de l'itération 2 (paquet L13) : délégation automatique sous plafond, en « Autonome avec contrôle ».
//
// Spécification §4.7 (D1 à D7), §4.1 (ligne « Travail délégué », colonne Autonome), §4.8.1 (plafond de délégations), §3.14 (garde
// du `task once`), §6 ligne « En mode Simple, l'IA ne délègue pas » ; décision n° 4 du 19/09 ; plan d'exécution, fiche L13.
//
// Ce que le scénario établit, en mode SIMPLE (le mode par défaut du cockpit) :
//   1. une délégation conforme (cible au catalogue et non principale, consigne sans @fichier ni « !` » ni adresse, IA autorisée,
//      garde-fou budgétaire d'accord, sous les plafonds) part SANS vous demander : ligne « Autorisé automatiquement », règle
//      A-task, par « règles », « once » relayé — c'est le seul cas où une délégation passe en mode Simple (§4.1) ;
//   2. l'enfant est bien lancé et travaille : le compteur de délégations de la demande autonome monte à 1 ;
//   3. P4 : la seule réponse relayée est « once » ; aucun « allow », « ask » ni « always » ne part vers opencode (témoin P6).
//
// En dehors du mode « --faux », rien n'est scripté : le faux fournisseur ne sait pas appeler un outil (limite du banc).
import {
  activerAutonome,
  activite,
  atelier,
  attendreDecisions,
  attendreIa,
  attendreQue,
  avecTemoinP6,
  decisionAuto,
  delegation,
  DOSSIER_ATELIER,
  envoyerEtJouer,
  exiger,
  nonJoue,
  oc,
  releve,
  resume,
} from "./it2-api-commun.mjs";

/** Cible de la délégation : sous-agent natif d'opencode, ni principal ni interne au cockpit (D1). */
const CIBLE = "general";
const CONSIGNE = "Relire les notes de l'atelier";

export async function run(ctx) {
  atelier(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "délégation automatique sous plafond", "le faux fournisseur ne sait pas appeler un outil");
    return;
  }
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);

  await avecTemoinP6(ctx, async (temoin) => {
    const racine = await client.creerConversation("it2-api-delegation");
    const vue = await activerAutonome(ctx, racine.id);
    exiger(vue.plafonds.delegationsMax >= 1, `plafond de délégations à ${vue.plafonds.delegationsMax} : rien ne pourrait passer.`);

    await envoyerEtJouer(
      ctx,
      client,
      racine.id,
      { tools: [delegation(CONSIGNE, CIBLE, { text: "Notes relues." })], cost: 0.003 },
      { ia },
    );

    // 1. Décision automatique A-task, par les règles, « once » relayé.
    const [task] = await attendreDecisions(ctx, racine.id, decisionAuto("A-task"), { delaiMs: 45_000, libelle: "délégation automatique (A-task)" });
    exiger(task.par === "regles", `A-task décidé par « ${task.par} » au lieu des règles.`);
    exiger(task.permission === "task", `A-task sur la permission « ${task.permission} ».`);
    exiger(task.relais === "ok", `A-task : relais « ${resume(task.relais)} ».`);
    exiger(task.resume === CIBLE, `A-task : résumé « ${resume(task.resume)} » au lieu de la cible.`);
    exiger(task.raison === "Travail délégué conforme, dans les plafonds", `A-task : raison « ${resume(task.raison)} » inattendue.`);

    // 2. L'enfant est lancé, et le compteur de délégations de la demande le dit.
    const enfant = await attendreQue(async () => ((await client.enfants(racine.id)) ?? [])[0] ?? false, { libelle: "sous-agent lancé" });
    exiger(enfant.parentID === racine.id, `enfant sans lien avec la racine : ${resume(enfant.parentID)}`);
    const demande = await attendreQue(
      async () => {
        const courante = await derniere(ctx, racine.id);
        return courante && courante.delegations >= 1 ? courante : false;
      },
      { libelle: "compteur de délégations de la demande autonome" },
    );
    exiger(demande.delegations === 1, `délégations comptées : ${demande.delegations} au lieu d'une.`);

    // 3. P4 : « once » et rien d'autre (le témoin vérifie aussi à la fermeture, pour tout le scénario).
    const reponses = (await temoin.requetes()).filter((r) => String(r.method).toUpperCase() === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname ?? ""));
    exiger(reponses.length === 1 && reponses[0].body?.reply === "once", `réponses relayées : ${resume(reponses.map((r) => r.body?.reply))}`);

    // Fin du tour : la pile revient au repos pour les scénarios suivants.
    await attendreQue(async () => ((await client.demandes()) ?? []).length === 0, { libelle: "plus aucune demande d'autorisation en attente" });
    releve(ctx, `délégation « ${CIBLE} » automatique en mode Simple (A-task, once relayé), 1 délégation comptée`);
  });
}

/** Demande autonome en cours de la conversation. */
async function derniere(ctx, rootId) {
  const requests = (await activite(ctx, rootId))?.requests ?? [];
  return requests.find((r) => r.endedAt === null) ?? null;
}
