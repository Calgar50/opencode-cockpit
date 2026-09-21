// Scénario e2e des équipes (itération 4, L41) : « Rien n'a été envoyé ni facturé » au pré-lancement (A4, D-eq-17).
//
// Sortie de la spécification §7.8 l.1189, deuxième phrase : « aucun refus de pré-lancement n'émet de requête », tenue À LA
// LETTRE. Le relevé est le JOURNAL COMPLET du faux opencode — toutes méthodes, tous chemins — entre l'envoi du lancement et
// sa réponse ; seules les requêtes de fond du cockpit en sont écartées (sondage des sessions, catalogue d'IA), jamais les
// trois lectures de l'estimation (`GET /agent`, `GET /command`, `GET /global/config`), qui sont justement celles qu'un refus
// ne doit pas faire.
//
// Ce que le scénario établit, dans la vraie pile, sur le faux opencode :
//   1. l'ESTIMATION, elle, lit opencode : elle rend une empreinte, une date de péremption, et le refus prévisible quand il
//      y en a un (`blocage`) — l'estimation n'est pas un refus de lancement ;
//   2. CHAQUE REFUS de `POST /api/teams/:id/run` laisse le faux sans la moindre requête, pour un code de chaque groupe :
//      groupe A (corps, base, système de fichiers, réglages) : `invalid`, `not-found`, `forbidden-directory`,
//      `fichier-refuse`, `confirmation-workspace`, `secret-probable` ;
//      groupe B (jugé sur l'INSTANTANÉ des lectures de l'estimation) : `estimation-perimee` (empreinte inconnue, puis
//      empreinte d'une autre équipe) et `extension-configuree` (configuration avec `mcp` LUE À L'ESTIMATION) ;
//   3. CHAQUE REFUS de `POST /api/team-runs/:id/relancer` fait de même (`not-found`, `confirmation-requise`) ;
//   4. FRAÎCHEUR : `mcp` ajouté APRÈS l'estimation → le lancement est ACCEPTÉ (202, l'instantané ne le savait pas), puis
//      l'équipe passe en pause « À vérifier » : AUCUN `prompt_async`, AUCUNE session d'étape, AUCUNE injection.
// Le scénario remet la configuration du faux comme il l'a trouvée et arrête le lancement laissé en pause.
// En « --reel-hors-ligne », le pilotage du faux n'existe pas : le scénario le dit et ne joue rien.
import { attendre, corpsJson, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import {
  attendreRun,
  configGlobale,
  corpsLancement,
  enAvance,
  equipeDerivee,
  equipes,
  LECTURES_ESTIMATION,
  MCP,
  refusSansRequete,
  repere,
  requetesDepuis,
} from "./it4-commun.mjs";

/** Demande qui ressemble à un secret : valeur manifestement factice, jamais affichée par le cockpit ni par ce scénario. */
const DEMANDE_AVEC_SECRET = "Relis la connexion : password=valeur-factice-du-banc";

/** Lancement inconnu : UUID valide qui n'existe dans aucune base. */
const RUN_INCONNU = "00000000-0000-4000-8000-000000000000";

/** Configuration sans extension : un objet `mcp` vide ne compte pas (lireConfig exige au moins une clé). */
const SANS_MCP = { mcp: {} };

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "refus de pré-lancement sans requête", "le journal du faux opencode et le pilotage de sa configuration n'existent qu'en mode « --faux »");
    ctx.expectNoConsoleErrors();
    return;
  }

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    const equipe = await equipeDerivee(api, "revue-sql", "p");
    await configGlobale(ctx, SANS_MCP);

    try {
      // 1. L'estimation lit opencode : empreinte, péremption, aucun blocage sur ce banc.
      const debutEstimation = await repere(ctx);
      const estimation = await api.estimer(equipe.id);
      const lues = await requetesDepuis(ctx, debutEstimation);
      exiger(/^[0-9a-f]{64}$/.test(estimation.estimateSha256), `empreinte d'estimation mal formée : ${resume(estimation.estimateSha256)}`);
      exiger(estimation.expireA > Date.now(), "l'instantané de l'estimation est déjà périmé.");
      exiger(estimation.blocage === null, `refus prévisible sur ce banc : ${resume(estimation.blocage)}`);
      for (const chemin of LECTURES_ESTIMATION) {
        exiger(
          lues.some((requete) => requete.method === "GET" && requete.pathname === chemin),
          `l'estimation n'a pas lu « GET ${chemin} » : ${resume(lues.map((r) => `${r.method} ${r.pathname}`))}`,
        );
      }
      releve(ctx, `estimation : ${lues.length} lecture(s) d'opencode, empreinte gardée jusqu'à ${new Date(estimation.expireA).toISOString()}`);

      // 2. Groupe A : corps, base, système de fichiers et réglages. Aucun ne touche opencode.
      const lancer = (patch) => () => api.lancerBrut(equipe.id, corpsLancement(estimation, patch));
      await refusSansRequete(ctx, "corps invalide", lancer({ fichiers: "pas un tableau" }), { code: 400, erreur: "invalid" });
      await refusSansRequete(
        ctx,
        "équipe inconnue",
        () => api.lancerBrut("equipe-absente-it4", corpsLancement(estimation)),
        { code: 404, erreur: "not-found" },
      );
      await refusSansRequete(ctx, "dossier hors du workspace", lancer({ directory: "/etc" }), { code: 403, erreur: "forbidden-directory" });
      await refusSansRequete(ctx, "pièce jointe hors du dossier", lancer({ fichiers: ["../secret.md"] }), { code: 403, erreur: "fichier-refuse" });
      await refusSansRequete(ctx, "racine du workspace sans confirmation", lancer({ confirmations: {} }), { code: 409, erreur: "confirmation-workspace" });
      const secret = await refusSansRequete(ctx, "secret probable sans confirmation", lancer({ demande: DEMANDE_AVEC_SECRET }), {
        code: 409,
        erreur: "secret-probable",
      });
      exiger(!JSON.stringify(secret).includes("valeur-factice-du-banc"), "le refus « secret probable » recopie la demande dans sa réponse.");

      // 2 bis. Groupe B : jugé sur l'instantané, toujours sans requête.
      await refusSansRequete(ctx, "empreinte inconnue", lancer({ estimateSha256: "b".repeat(64) }), { code: 409, erreur: "estimation-perimee" });
      const autre = await api.estimer("relecture-script");
      await refusSansRequete(ctx, "empreinte d'une autre équipe", lancer({ estimateSha256: autre.estimateSha256 }), {
        code: 409,
        erreur: "estimation-perimee",
      });

      // 2 ter. Configuration avec `mcp` LUE À L'ESTIMATION : l'estimation l'annonce, le lancement le refuse sans requête.
      await configGlobale(ctx, MCP);
      const avecMcp = await api.estimer(equipe.id);
      exiger(avecMcp.blocage?.code === "extension-configuree", `l'estimation n'annonce pas l'extension : ${resume(avecMcp.blocage)}`);
      await refusSansRequete(
        ctx,
        "extension configurée, lue à l'estimation",
        () => api.lancerBrut(equipe.id, corpsLancement(avecMcp)),
        { code: 409, erreur: "extension-configuree" },
      );

      // 3. Refus de relance : eux aussi sans requête.
      await refusSansRequete(
        ctx,
        "relance d'un lancement inconnu",
        () => api.relancerBrut(RUN_INCONNU, { estimateSha256: estimation.estimateSha256 }),
        { code: 404, erreur: "not-found" },
      );

      // 4. Fraîcheur : `mcp` ajouté APRÈS une estimation propre.
      await configGlobale(ctx, SANS_MCP);
      const propre = await api.estimer(equipe.id);
      exiger(propre.blocage === null, `l'estimation propre est bloquée : ${resume(propre.blocage)}`);
      await configGlobale(ctx, MCP);

      // Lancement ACCEPTÉ : il n'est pas mesuré comme un refus. Le contrôle de fraîcheur du runner refait, APRÈS la
      // réponse 202, les lectures de l'estimation : c'est justement lui qui verra le changement.
      const debutLancement = await repere(ctx);
      const accepte = await api.lancerBrut(equipe.id, corpsLancement(propre));
      exiger(accepte.code === 202, `lancement refusé (${accepte.code}) au lieu d'être accepté : ${resume(accepte.corps)}`);
      const { runId, rootId } = corpsJson(accepte, "lancement accepté");

      const enPause = await attendreRun(api, runId, (vue) => vue.state.startsWith("attente-"), "pause après le contrôle de fraîcheur");
      exiger(enPause.state === "attente-verification", `état « ${enPause.state} » au lieu de « attente-verification ».`);
      exiger(enPause.cause === "changement", `cause « ${enPause.cause} » au lieu de « changement ».`);
      await attendre(500);
      const depuis = await requetesDepuis(ctx, debutLancement);
      const envois = depuis.filter((requete) => requete.method === "POST" && requete.pathname.endsWith("/prompt_async"));
      exiger(envois.length === 0, `${envois.length} envoi(s) malgré le changement : ${resume(envois.map((r) => r.pathname))}`);
      // Sessions d'ÉTAPE seulement : la racine de la conversation, elle, est bien créée (le lancement a été accepté).
      const sessions = (await ctx.opencodeRequests())
        .slice(debutLancement)
        .filter((requete) => requete.method === "POST" && requete.pathname === "/session" && requete.body?.metadata?.cockpit === "equipe");
      exiger(sessions.length === 0, `${sessions.length} session(s) d'étape créée(s) malgré le changement.`);
      const injections = depuis.filter((requete) => requete.method === "POST" && requete.pathname === `/session/${rootId}/message`);
      exiger(injections.length === 0, `${injections.length} injection(s) dans la racine malgré le changement.`);
      exiger(
        enPause.steps.every((step) => step.state === "prevue" || step.state === "non-lancee"),
        `étapes lancées malgré le changement : ${resume(enPause.steps.map((s) => `${s.stepId}=${s.state}`))}`,
      );
      releve(ctx, `changement après l'estimation : 202 puis pause « À vérifier », ${depuis.length} requête(s) au total, aucun envoi`);

      // 3 bis. Relance d'un lancement réel, sans confirmation : 428, toujours sans requête.
      await refusSansRequete(ctx, "relance sans confirmation", () => api.relancerBrut(runId, { estimateSha256: propre.estimateSha256 }), {
        code: 428,
        erreur: "confirmation-requise",
      });

      // La pile est partagée : le lancement laissé en pause est arrêté, sinon il compterait parmi les équipes actives.
      const arret = await api.arreterBrut(runId);
      exiger(arret.code === 200, `arrêt du lancement en pause refusé (${arret.code}) : ${resume(arret.corps)}`);
      await attendreRun(api, runId, (vue) => vue.state === "arretee", "lancement en pause arrêté");
    } finally {
      // La configuration du faux est remise comme trouvée, quoi qu'il arrive : les scénarios suivants partagent la pile.
      await configGlobale(ctx, SANS_MCP);
    }
  });

  ctx.expectNoConsoleErrors();
}
