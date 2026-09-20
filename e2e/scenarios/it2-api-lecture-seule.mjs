// Scénario e2e de l'itération 2 (paquet L13) : « Lecture seule » en « Autonome avec contrôle ».
//
// Spécification §4.11 (« Refus des assistants » : un `deny` ne produit JAMAIS de demande, F-b ; test « assistant Lecture seule en
// Autonome, aucun outil `edit` visible, aucune demande `edit` »), §4.2 (règles `allow`/`ask` de session exclues, P4), §6 ligne
// « Ne lève jamais un refus de l'assistant » ; plan d'exécution, fiche L13.
//
// Ce que le scénario établit, en « Autonome avec contrôle » :
//   1. AUCUN OUTIL `edit` VISIBLE : pour un assistant dont la dernière règle sur `edit` est « deny », les outils qu'opencode
//      enverrait à l'IA ne contiennent ni `edit`, ni `write`, ni `apply_patch` (oracle du faux, vérifié contre la mesure M2) ;
//   2. AUCUNE DEMANDE `edit` : quand l'IA appelle quand même l'outil, opencode lève son refus SANS poser de demande
//      d'autorisation (F-b) ; l'autonomie ne voit donc rien, n'écrit aucune ligne de Journal `edit` et ne relaie aucune réponse ;
//   3. le refus de l'assistant n'est JAMAIS levé : aucune règle `allow`, `ask` ou `always` n'est envoyée à opencode (témoin P6 et
//      P4), et la conversation reste en « Autonome avec contrôle » — l'autonomie continue sur ce qu'elle a le droit de décider
//      (une consultation dans le dossier passe automatiquement dans le même tour).
//
// Limite du banc, dite ici : le faux opencode du banc sert les assistants natifs d'opencode 1.18.30 et le banc n'a pas de route
// pour lui en installer un de plus. L'assistant « Lecture seule » est donc joué par SES RÈGLES, portées par l'appel d'outil
// (`agentRules`), que le faux évalue avant celles de la session, exactement comme opencode (F-d) — c'est déjà ce que fait le
// scénario `it1-api-pfx-explore.mjs`.
import { builtinTools, disabledTools } from "../../app/server/test-support/fake-opencode.ts";
import {
  activerAutonome,
  activite,
  atelier,
  attendreDecisions,
  attendreIa,
  attendreQue,
  avecTemoinP6,
  commande,
  decisionAuto,
  DOSSIER_ATELIER,
  envoyerEtJouer,
  exiger,
  exigerListe,
  nonJoue,
  oc,
  partiesOutil,
  releve,
  resume,
} from "./it2-api-commun.mjs";

/** Règles de l'assistant « Lecture seule » : il refuse toute modification, et ne demande rien d'autre au cockpit. */
const LECTURE_SEULE = [{ permission: "edit", pattern: "*", action: "deny" }];

/** Outils qui modifient (ECRIVAINS de L7b-1, sans `bash` : « Lecture seule » garde les consultations). */
const MODIFICATEURS = ["apply_patch", "edit", "write"];

/** Consultation du corpus de la sonde : elle doit continuer à passer automatiquement dans le même tour. */
const CONSULTATION = "cat notes.txt";

export async function run(ctx) {
  atelier(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "« Lecture seule » en Autonome", "aucun tour ne se script hors du faux opencode");
    return;
  }
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);

  // 1. Aucun outil qui modifie n'est proposé à l'IA (oracle du faux : builtinTools moins ceux qu'une règle « * deny » retire).
  const outils = builtinTools("gpt-5-mini");
  const retires = disabledTools(outils, LECTURE_SEULE);
  const proposes = outils.filter((o) => !retires.has(o)).sort();
  const restes = proposes.filter((o) => MODIFICATEURS.includes(o));
  exigerListe(restes, [], "« Lecture seule » : outils qui modifient encore proposés à l'IA");
  exiger(proposes.includes("read") && proposes.includes("grep"), `« Lecture seule » : la lecture a disparu aussi (${resume(proposes)}).`);

  await avecTemoinP6(ctx, async (temoin) => {
    const racine = await client.creerConversation("it2-api-lecture-seule");
    await activerAutonome(ctx, racine.id);

    // 2 et 3. L'IA tente quand même une modification, et fait une consultation dans le même tour.
    await envoyerEtJouer(
      ctx,
      client,
      racine.id,
      {
        tools: [
          {
            tool: "write",
            input: { filePath: `${DOSSIER_ATELIER}/interdit.md`, content: "cette écriture ne doit jamais partir\n" },
            ask: { permission: "edit", patterns: ["interdit.md"] },
            agentRules: LECTURE_SEULE,
          },
          commande(CONSULTATION),
        ],
        cost: 0.002,
      },
      { ia },
    );

    // La consultation passe : elle prouve que l'autonomie a bien travaillé sur ce tour.
    const [lecture] = await attendreDecisions(ctx, racine.id, decisionAuto("A-cat"), { libelle: "consultation automatique (A-cat)" });
    exiger(lecture.relais === "ok", `A-cat : relais « ${resume(lecture.relais)} ».`);

    // La modification a été refusée par l'assistant, SANS demande d'autorisation.
    const messages = await attendreQue(
      async () => {
        const lus = await client.messages(racine.id);
        const partie = partiesOutil(lus, "write")[0];
        return partie && partie.state?.status !== "pending" && partie.state?.status !== "running" ? lus : false;
      },
      { libelle: "appel `write` tranché par l'assistant" },
    );
    const ecriture = partiesOutil(messages, "write")[0];
    exiger(ecriture.state.status === "error", `l'écriture a été ${resume(ecriture.state.status)} au lieu d'être refusée par l'assistant.`);
    exiger(/rule which prevents you/.test(String(ecriture.state.error)), `écriture refusée pour une autre raison : ${resume(ecriture.state.error)}`);

    const demandesEdit = temoin.deOpencode("permission.asked").filter((e) => e.event.properties?.permission === "edit");
    exiger(demandesEdit.length === 0, `demande d'autorisation « edit » posée : ${resume(demandesEdit.map((e) => e.event.properties?.patterns))}`);
    const journal = ((await activite(ctx, racine.id))?.decisions ?? []).filter((d) => d.permission === "edit");
    exiger(journal.length === 0, `ligne(s) de Journal sur « edit » alors qu'aucune demande n'a été posée : ${resume(journal)}`);

    // Aucun assouplissement : la seule réponse relayée est le « once » de la consultation.
    const reponses = (await temoin.requetes()).filter((r) => String(r.method).toUpperCase() === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname ?? ""));
    exiger(reponses.length === 1 && reponses[0].body?.reply === "once", `réponses relayées : ${resume(reponses.map((r) => r.body?.reply))}`);
    const regles = (await temoin.requetes()).filter((r) => String(r.method).toUpperCase() === "PATCH" && /^\/session\/[^/]+$/.test(r.pathname ?? ""));
    const permissives = regles.filter((r) => JSON.stringify(r.body?.permission ?? []).includes('"allow"') || JSON.stringify(r.body?.permission ?? []).includes('"ask"'));
    exiger(permissives.length === 0, `règle permissive envoyée à opencode : ${resume(permissives.map((r) => r.body?.permission))}`);

    releve(ctx, "« Lecture seule » en Autonome : aucun outil qui modifie proposé, aucune demande `edit`, aucun refus levé");
  });
}
