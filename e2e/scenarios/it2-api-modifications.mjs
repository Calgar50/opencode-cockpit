// Scénario e2e de l'itération 2 (paquet L13) : modification automatique dans le dossier, attente sur un fichier protégé.
//
// Spécification §4.1 (ligne « Modifier un fichier du dossier, non protégé » et ligne « Fichier protégé »), §4.4 (E1 à E6), §4.3
// (cycle d'une décision : relais d'un « once », ligne de Journal), §4.12 (Journal du contrôle), §6 lignes « Autorisé
// automatiquement » et « Ne lève jamais un refus de l'assistant » ; plan d'exécution, fiche L13.
//
// Ce que le scénario établit, en « Autonome avec contrôle », sur le dépôt propre de l'atelier :
//   1. la confirmation est celle du SERVEUR : un PUT sans en-tête reçoit 428 `confirmation-requise`, le même PUT confirmé passe ;
//   2. une écriture dans le dossier (rapport.md) part sans vous demander : ligne « Autorisé automatiquement », règle A-edit, par
//      « règles », et le cockpit a bien relayé « once » à opencode pour CETTE demande ;
//   3. une écriture dans .github/workflows/ (fichier protégé, E2) ATTEND : aucune réponse relayée, la demande reste en attente dans
//      opencode, et la ligne de Journal dit « En attente de votre accord » avec la règle E2 ;
//   4. les compteurs de la demande autonome disent la même chose (une automatique, une attente, un fichier) ;
//   5. P4 : les seules réponses envoyées à opencode sont « once » (l'automatique) et « reject » (le refus final de l'utilisateur,
//      qui libère la pile pour les scénarios suivants) ; P6 : témoin ouvert avant toute action.
//
// En dehors du mode « --faux », rien n'est scripté : le scénario le dit et s'arrête là (aucune IA réelle n'écrit à la demande).
import {
  activerAutonome,
  activite,
  atelier,
  attendreDecisions,
  attendreDemandes,
  attendreIa,
  attendreQue,
  avecTemoinP6,
  decisionAttente,
  decisionAuto,
  DOSSIER_ATELIER,
  ecriture,
  envoyerEtJouer,
  exiger,
  nonJoue,
  oc,
  releve,
  resume,
} from "./it2-api-commun.mjs";

/** Fichier neuf du dossier : aucune ligne retirée (E3), aucun chemin protégé (E2), parent existant (E1). */
const FICHIER_AUTO = "rapport.md";
/** Fichier protégé par E2 : « .github/** » est dans la liste exacte du §4.4. */
const FICHIER_PROTEGE = ".github/workflows/ci.yml";

export async function run(ctx) {
  atelier(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "modification automatique et fichier protégé", "aucun tour ne se script hors du faux opencode");
    return;
  }
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);

  await avecTemoinP6(ctx, async (temoin) => {
    const racine = await client.creerConversation("it2-api-modifications");

    // 1. Activation : 428 puis 200 (activerAutonome vérifie les deux).
    const vue = await activerAutonome(ctx, racine.id);
    exiger(vue.demande === null, `demande autonome ouverte avant tout envoi : ${resume(vue.demande)}`);

    // 2 et 3. Un tour qui écrit deux fichiers : l'un dans le dossier, l'autre protégé.
    await envoyerEtJouer(
      ctx,
      client,
      racine.id,
      {
        tools: [
          ecriture(DOSSIER_ATELIER, FICHIER_AUTO, "# Rapport\n\nÉcrit par l'atelier.\n"),
          ecriture(DOSSIER_ATELIER, FICHIER_PROTEGE, "name: ci\non: push\n"),
        ],
        cost: 0.002,
      },
      { ia },
    );

    // La modification du dossier : décision automatique, règle A-edit, par les règles.
    const [auto] = await attendreDecisions(ctx, racine.id, decisionAuto("A-edit"), { libelle: "décision automatique A-edit" });
    exiger(auto.par === "regles", `A-edit décidé par « ${auto.par} » au lieu des règles.`);
    exiger(auto.permission === "edit", `A-edit sur la permission « ${auto.permission} ».`);
    exiger(auto.relais === "ok", `A-edit : relais « ${resume(auto.relais)} » au lieu de « ok ».`);
    exiger(auto.resume.includes(FICHIER_AUTO), `A-edit : résumé « ${resume(auto.resume)} » sans le fichier visé.`);

    // Le fichier protégé : ligne « En attente de votre accord », règle E2, et la demande attend toujours dans opencode.
    const [attente] = await attendreDecisions(ctx, racine.id, decisionAttente("E2"), { libelle: "décision en attente E2" });
    exiger(attente.par === "regles", `E2 décidé par « ${attente.par} » au lieu des règles.`);
    exiger(attente.relais === null, `E2 : une réponse a été relayée (${resume(attente.relais)}).`);
    const enAttente = await attendreDemandes(client, (d) => d.permission === "edit" && d.sessionID === racine.id, {
      libelle: "demande d'autorisation du fichier protégé, toujours en attente dans opencode",
    });
    exiger(enAttente.length === 1, `${enAttente.length} demande(s) d'autorisation en attente au lieu d'une.`);
    exiger(
      JSON.stringify(enAttente[0].metadata?.filepath ?? "").includes(FICHIER_PROTEGE),
      `la demande en attente n'est pas celle du fichier protégé : ${resume(enAttente[0].metadata)}`,
    );

    // Le cockpit n'a relayé qu'UNE réponse, « once », et elle ne porte pas sur la demande du fichier protégé.
    const reponses = (await temoin.requetes()).filter((r) => String(r.method).toUpperCase() === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname ?? ""));
    exiger(reponses.length === 1, `${reponses.length} réponse(s) d'autorisation relayée(s) au lieu d'une : ${resume(reponses.map((r) => r.body?.reply))}`);
    exiger(reponses[0].body?.reply === "once", `réponse relayée « ${resume(reponses[0].body?.reply)} » au lieu de « once ».`);
    exiger(!reponses[0].pathname.includes(enAttente[0].id), "le cockpit a répondu pour la demande du fichier protégé.");

    // 4. Compteurs de la demande autonome (§4.8.1, §4.12) : une automatique, une attente, un fichier modifié.
    const demande = await attendreQue(
      async () => {
        const courante = ((await activite(ctx, racine.id))?.requests ?? []).find((r) => r.endedAt === null);
        return courante && courante.auto >= 1 && courante.attentes >= 1 ? courante : false;
      },
      { libelle: "compteurs de la demande autonome" },
    );
    exiger(demande.choix === "autonome", `demande ouverte avec le choix « ${demande.choix} ».`);
    exiger(demande.fichiers === 1, `fichiers comptés : ${demande.fichiers} au lieu d'un seul (E5 compte les fichiers distincts).`);
    exiger(demande.auto === 1 && demande.attentes === 1, `compteurs : ${demande.auto} automatique(s), ${demande.attentes} attente(s).`);

    // 5. L'utilisateur refuse la demande restée en attente : la pile revient au repos pour les scénarios suivants.
    const refus = await client.repondre(enAttente[0].id, "reject");
    exiger(refus.code === 200 || refus.code === 204, `refus de l'utilisateur : code ${refus.code} (${resume(refus.corps)}).`);
    await attendreQue(async () => ((await client.demandes()) ?? []).length === 0, { libelle: "plus aucune demande d'autorisation en attente" });

    releve(
      ctx,
      `modification automatique (${FICHIER_AUTO}, A-edit, once relayé) ; fichier protégé en attente (${FICHIER_PROTEGE}, E2, ` +
        "aucune réponse relayée) ; 1 automatique, 1 attente, 1 fichier",
    );
  });
}
