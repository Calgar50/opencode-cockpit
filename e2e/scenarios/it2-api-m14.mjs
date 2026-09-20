// Scénario e2e de l'itération 2 (paquet L13) : M14, opencode redémarre → la demande devient « interrompue ».
//
// Spécification §4.11 (« Redémarrages » : opencode refuse les demandes en attente et annule les tours ; demande « interrompue »,
// retour à « Demander à chaque fois »), §4.12 (fin de demande), mesure MX1 §2 reprise par la fiche M14 ; plan d'exécution,
// fiche L13.
//
// CE QUI EST JOUÉ, ET CE QUI NE L'EST PAS.
// Le banc ne peut pas redémarrer le conteneur d'opencode depuis un scénario : la coupure du flux serait vue par le témoin P6
// comme un redémarrage de l'instance principale, ce que P6 interdit. Le scénario rejoue donc le SIGNAL que la mesure MX1 §2 a
// relevé sur un vrai redémarrage : `session.error` **MessageAbortedError sur la session RACINE**, émis par le faux opencode dans
// un tour scripté (`error` de FakeTurnScript). C'est exactement l'entrée que la surveillance de l'autonomie écoute pour conclure
// au redémarrage (`onSessionError`, autonomy-watch.ts).
//
// Pourquoi PAS `POST /session/:id/abort` : sur une racine suivie, le cockpit intercepte cet appel (crochet `abort` de
// stop-tree.ts) et en fait votre « Arrêter » — un arrêt VOULU, qui clôt la demande avant d'arrêter les sessions. La surveillance
// ne voit alors plus de demande ouverte et ne conclut à aucun redémarrage : la route d'arrêt ne peut donc pas servir de signal de
// redémarrage. (Essai du 20/09 : la demande ne passait jamais « interrompue ».)
//
// Ce que le scénario établit :
//   1. l'autonomie travaille : une modification dans le dossier part sans vous demander (A-edit, « once » relayé) ;
//   2. au signal de redémarrage, la demande autonome en cours est close « interrompue » ;
//   3. la conversation revient à « Demander à chaque fois », cause « interrompue » : plus rien ne part sans vous ;
//   4. plus aucune demande d'autorisation n'attend, et l'arbre est au repos.
//
// RECETTE EN ATTENTE, consignée pour DOC2 : le redémarrage RÉEL du conteneur d'opencode, avec une demande d'autorisation en
// attente au moment de la coupure (§4.11 : « les demandes d'autorisation disparaissent SANS réponse »). Il se joue à la main sur
// la pile du banc (`--garder-pile`, puis `docker compose … restart opencode`), jamais depuis un scénario : le faux ne sait pas
// perdre ses demandes en attente sans les refuser, et un tour bloqué sur une demande ne rend jamais la main au tour suivant.
import {
  activerAutonome,
  atelier,
  attendreDecisions,
  attendreFinDeDemande,
  attendreIa,
  attendreQue,
  auRepos,
  avecTemoinP6,
  decisionAuto,
  DOSSIER_ATELIER,
  ecriture,
  envoyerEtJouer,
  exiger,
  lireAutonomie,
  nonJoue,
  oc,
  releve,
  resume,
} from "./it2-api-commun.mjs";

/** Fichier du dossier, non protégé : sa modification part toute seule (A-edit) et prouve que l'autonomie travaillait. */
const FICHIER_AUTO = "m14.md";

/**
 * Signal relevé par la mesure MX1 §2 sur un vrai redémarrage d'opencode, à la lettre (fake-opencode.ts, constante ABORTED) :
 * `session.error` MessageAbortedError sur la session racine, tours annulés.
 */
const REDEMARRAGE = { name: "MessageAbortedError", data: { message: "Aborted" } };

/** Pause du tour d'erreur : le signal part après l'ouverture de la demande autonome, jamais avant (deux pas de `stepMs`). */
const PAS_MS = 800;

export async function run(ctx) {
  atelier(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "M14 (demande interrompue)", "aucun tour ne se script hors du faux opencode");
    return;
  }
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);

  await avecTemoinP6(ctx, async () => {
    const racine = await client.creerConversation("it2-api-m14");
    await activerAutonome(ctx, racine.id);

    // 1. L'autonomie travaille : une modification du dossier part sans vous demander.
    await envoyerEtJouer(ctx, client, racine.id, { tools: [ecriture(DOSSIER_ATELIER, FICHIER_AUTO, "# M14\n")], cost: 0.002 }, { ia });
    const [auto] = await attendreDecisions(ctx, racine.id, decisionAuto("A-edit"), { libelle: "modification automatique avant le redémarrage" });
    exiger(auto.relais === "ok", `A-edit : relais « ${resume(auto.relais)} » avant le redémarrage.`);

    // 2. Le signal de redémarrage. L'envoi clôt la demande précédente (« terminée ») et en ouvre une neuve : c'est CELLE-LÀ que
    // le signal doit interrompre. On la relève ouverte avant que le tour ne publie son erreur.
    await envoyerEtJouer(ctx, client, racine.id, { error: REDEMARRAGE, stepMs: PAS_MS }, { texte: "Continue.", ia });
    const ouverte = await attendreQue(
      async () => {
        const lue = await lireAutonomie(ctx, racine.id);
        return lue?.demande ? lue.demande : false;
      },
      { delaiMs: 10_000, pasMs: 50, libelle: "demande autonome ouverte au moment du redémarrage" },
    );
    exiger(ouverte.fin === null, `demande déjà close avant le signal : ${resume(ouverte.fin)}`);

    const close = await attendreFinDeDemande(ctx, racine.id, "interrompue");
    exiger(close.id === ouverte.id, `une autre demande a été close (${resume(close.id)} au lieu de ${resume(ouverte.id)}).`);

    // 3. Retour à « Demander à chaque fois », cause « interrompue ».
    const apres = await attendreQue(
      async () => {
        const lue = await lireAutonomie(ctx, racine.id);
        return lue?.choix === "demander" ? lue : false;
      },
      { libelle: "retour à « Demander à chaque fois » après le redémarrage" },
    );
    exiger(apres.retourCause === "interrompue", `cause du retour : ${resume(apres.retourCause)} au lieu de « interrompue ».`);
    exiger(apres.demande === null, `une demande autonome est restée ouverte : ${resume(apres.demande)}`);

    // 4. Plus rien n'attend, plus rien ne travaille.
    await attendreQue(async () => ((await client.demandes()) ?? []).length === 0, { libelle: "plus aucune demande d'autorisation en attente" });
    await attendreQue(async () => await auRepos(client, [racine.id]), { libelle: "racine au repos après le redémarrage" });

    releve(
      ctx,
      "M14 (signal MessageAbortedError de la racine, mesure MX1 §2) : demande autonome close « interrompue », retour à " +
        "« Demander à chaque fois », aucune attente restante. Redémarrage réel du conteneur opencode, avec une demande " +
        "d'autorisation en attente : recette en attente.",
    );
  });
}
