// Scénario e2e de l'itération 5 (répétition générale de la 5a) : MC5-1 REJOUÉE SUR LE CODE RÉEL.
//
// La mesure MC5 (train de V0 de 5a, `mesures/MC5.md`) a été faite hors dépôt, sur un banc dédié. Le plan d'exécution it5
// demande aux répétitions générales de rejouer ses points « sur le code réel (`--reel-hors-ligne`, projets c511-rg-*) »
// (§3.1 ; fiche L50a : « en réel hors ligne : MC5-1 rejouée sur le code réel par la répétition générale »). Aucun scénario
// ne le faisait : les quatre scénarios `c5a-*` de L50a pilotent le FAUX opencode et ne sont pas joués en réel. Celui-ci
// comble ce trou : un VRAI opencode 1.18.30, le faux fournisseur hors ligne du banc, aucun appel facturé, jamais Copilot.
//
// Ce qu'il établit, dans une SEULE conversation, avec le protocole de MC5-1 (§3.1) :
//   1. un envoi à l'assistant « Analyser un incident » est accepté (204 SANS CORPS, observation de MC5) ;
//   2. un envoi au « Relecteur critique » DANS LA MÊME conversation est accepté lui aussi : le fournisseur reçoit une
//      invite système DIFFÉRENTE (celle du Relecteur, et elle seule) et TOUT l'historique — le nombre de messages de la
//      requête a grandi d'au moins deux ;
//   3. un troisième envoi au premier assistant retrouve SON invite système : le passage du Relecteur NE COLLE PAS à la
//      session (c'est la conclusion de MC5-1, celle dont dépendent L44c et L44e : aucun contrat de repli) ;
//   4. `GET /session/:id/message` porte `agent` sur chaque message, messages `user` compris (observation de MC5) ;
//   5. le crochet `beforeBilledSend` de la Seconde lecture a requalifié la ligne `chat_turns` du VRAI envoi :
//      `GET /api/chat/choices/:id` rend l'assistant PRÉCÉDENT, pas le Relecteur (D-5-06), sur le chemin réel du proxy.
//
// Ce qu'il NE rejoue PAS, et pourquoi : MC5-1 relève aussi les PARTIES D'OUTIL dans l'historique transmis. Le faux
// fournisseur du banc (`e2e/lib/faux-fournisseur.mjs`, propriété de L7a) ne sait répondre que du texte : il ne peut pas
// scripter un appel d'outil, et son relevé ne garde aucun texte de message (P-secrets), seulement l'empreinte de l'invite
// système et le NOMBRE de messages. Ce point reste tenu par MC5 elle-même, sur son banc dédié. Écart consigné.
import { attendreFinDuTour, attendreQue, enModeAvance, exiger, iaDuBanc, nonJoue, oc, releve, resume } from "./it1-api-commun.mjs";

/** Assistants du catalogue livré (assistants-catalogue.ts ; `relecteur-critique` = SECOND_READING_CATALOG_ID). */
const ANALYSTE = "analyser-incident";
const RELECTEUR = "relecteur-critique";

const DEMANDE_1 = "Le traitement de nuit s est arrete vers 3 h. Que verifier en premier ?";
const DEMANDE_3 = "Et la veille, a la meme heure ?";

/**
 * Message de seconde lecture, écrit en clair : c'est la phrase du §4.3 que le crochet reconnaît (`secondReadingPrefix`).
 * Le scénario vérifie le CODE RÉEL ; il ne lui emprunte pas son texte.
 */
const secondeLecture = (assistant) =>
  `Seconde lecture de la réponse précédente de « ${assistant} ». Vérifie-la avec ta liste de contrôle. Relis les fichiers cités si tu y as accès. Ne change pas une conclusion sourcée sans fait nouveau.`;

/** Installe un assistant du catalogue livré et rend sa fiche (route existante, celle du bouton [Installer]). */
async function installer(ctx, catalogId) {
  const pose = await ctx.api.post(`/api/assistants/catalogue/${encodeURIComponent(catalogId)}/install`, {});
  exiger(typeof pose?.name === "string" && pose.name.length > 0, `assistant « ${catalogId} » non installé : ${resume(pose)}`);
  return pose;
}

/**
 * Requêtes principales du faux fournisseur depuis `debut` : celles qui proposent des outils. La requête de titre n'en
 * propose aucune (MX1 §5), et opencode en envoie une par conversation neuve.
 */
async function appelsPrincipaux(ctx, debut) {
  return (await ctx.billedCalls()).slice(debut).filter((r) => Array.isArray(r.outils) && r.outils.length > 0);
}

/** Attend qu'opencode serve ces agents (fichiers écrits par le cockpit, relus par opencode). */
async function attendreAgentsServis(client, noms) {
  return await attendreQue(
    async () => {
      const servis = (await client.agents()) ?? [];
      const manquants = noms.filter((nom) => !servis.some((a) => a.name === nom));
      return manquants.length === 0 ? servis : false;
    },
    { delaiMs: 90_000, pasMs: 2_000, libelle: `agents servis par opencode : ${noms.join(", ")}` },
  );
}

export async function run(ctx) {
  if (ctx.mode !== "reel-hors-ligne") {
    nonJoue(ctx, "MC5-1 sur le code réel", "elle demande un VRAI opencode et le faux fournisseur hors ligne (« --reel-hors-ligne »)");
    return;
  }
  const client = oc(ctx);
  // Le catalogue d'IA du cockpit vient d'opencode, qui interroge le fournisseur à son démarrage : on l'attend.
  const ia = await attendreQue(
    async () => {
      const bootstrap = await ctx.api.get("/api/bootstrap");
      const fournisseur = bootstrap?.allowedProviders?.[0];
      if (typeof fournisseur !== "string") return false;
      const modele = bootstrap.modelDefaults?.[fournisseur] ?? bootstrap.models?.find((m) => m.providerID === fournisseur)?.modelID;
      return typeof modele === "string" ? iaDuBanc(bootstrap) : false;
    },
    { delaiMs: 60_000, pasMs: 2_000, libelle: "IA du banc au catalogue du cockpit" },
  );

  // 0 bis. Les trois niveaux d'IA pointent sur la seule IA du banc. Sans cela, l'installation d'un assistant du catalogue
  // est refusée (422 « ia-indisponible ») : les niveaux livrés ne proposent que des IA Copilot, absentes hors ligne
  // (MX1 §8). C'est le réglage existant des niveaux, celui de l'éditeur de la page Réglages ; rien n'est contourné.
  const niveau = { candidates: [`${ia.providerID}/${ia.modelID}`], variant: null };
  await enModeAvance(ctx, async () => {
    const regles = await ctx.api.put("/api/settings", { ai: { tiers: { rapide: niveau, equilibre: niveau, expert: niveau } } });
    exiger(regles?.ai?.tiers?.rapide?.candidates?.[0] === niveau.candidates[0], `niveaux d'IA non réglés sur le banc : ${resume(regles?.ai?.tiers)}`);
  });

  // 0. Les deux assistants du catalogue livré, installés par la route du bouton [Installer], puis servis par opencode.
  const analyste = await installer(ctx, ANALYSTE);
  const relecteur = await installer(ctx, RELECTEUR);
  await attendreAgentsServis(client, [analyste.name, relecteur.name]);
  releve(ctx, `assistants installés et servis : ${analyste.name}, ${relecteur.name}`);

  // 1. Conversation créée par le cockpit : son plancher CONVERSATION est posé par L3, le corps du client ne porte que le titre.
  const racine = await client.creerConversation("c5a-mc5-reel");
  exiger(typeof racine?.id === "string", `conversation non créée : ${resume(racine)}`);

  const depart = (await ctx.billedCalls()).length;
  const envoi1 = await client.envoyer(racine.id, DEMANDE_1, ia, analyste.name);
  exiger(envoi1.code === 204, `premier envoi refusé (${envoi1.code}) : ${resume(envoi1.corps)}`);
  // Observation de MC5 : prompt_async rend 204 SANS corps. Un paquet qui lirait le corps se tromperait.
  exiger(envoi1.corps === null || envoi1.corps === "" || envoi1.corps === undefined, `204 avec un corps : ${resume(envoi1.corps)}`);
  await attendreFinDuTour(client, racine.id);
  const apres1 = await appelsPrincipaux(ctx, depart);
  exiger(apres1.length >= 1, `aucun appel principal reçu par le faux fournisseur après le premier envoi : ${resume(apres1)}`);
  const premier = apres1[0];
  releve(ctx, `appel 1 (${analyste.name}) : ${JSON.stringify({ modele: premier.modele, systeme: premier.systeme, messages: premier.messages })}`);
  exiger(premier.modele === ia.modelID, `IA reçue « ${premier.modele} » au lieu de « ${ia.modelID} ».`);

  // 2. Seconde lecture : un message ORDINAIRE au Relecteur, dans la MÊME conversation (voie principale, MC5-1).
  const avant2 = (await ctx.billedCalls()).length;
  const envoi2 = await client.envoyer(racine.id, secondeLecture(analyste.title ?? analyste.name), ia, relecteur.name);
  exiger(envoi2.code === 204, `envoi de la seconde lecture refusé (${envoi2.code}) : ${resume(envoi2.corps)}`);
  await attendreFinDuTour(client, racine.id);
  const apres2 = await appelsPrincipaux(ctx, avant2);
  exiger(apres2.length >= 1, `aucun appel principal après la seconde lecture : ${resume(apres2)}`);
  const second = apres2[0];
  releve(ctx, `appel 2 (${relecteur.name}) : ${JSON.stringify({ modele: second.modele, systeme: second.systeme, messages: second.messages })}`);
  exiger(second.systeme !== premier.systeme, `le Relecteur a reçu l'invite système de l'assistant précédent (${second.systeme}).`);
  exiger(
    second.messages >= premier.messages + 2,
    `historique non transmis au Relecteur : ${second.messages} message(s) contre ${premier.messages} au premier appel (deux de plus attendus au moins).`,
  );

  // 3. Le passage du Relecteur ne colle pas à la session : le troisième envoi retrouve l'invite système du premier.
  const avant3 = (await ctx.billedCalls()).length;
  const envoi3 = await client.envoyer(racine.id, DEMANDE_3, ia, analyste.name);
  exiger(envoi3.code === 204, `troisième envoi refusé (${envoi3.code}) : ${resume(envoi3.corps)}`);
  await attendreFinDuTour(client, racine.id);
  const apres3 = await appelsPrincipaux(ctx, avant3);
  exiger(apres3.length >= 1, `aucun appel principal après le troisième envoi : ${resume(apres3)}`);
  const troisieme = apres3[0];
  releve(ctx, `appel 3 (${analyste.name}) : ${JSON.stringify({ modele: troisieme.modele, systeme: troisieme.systeme, messages: troisieme.messages })}`);
  exiger(
    troisieme.systeme === premier.systeme,
    `le Relecteur colle à la session : invite système ${troisieme.systeme} au troisième envoi, ${premier.systeme} au premier.`,
  );
  exiger(troisieme.messages >= second.messages + 2, `historique perdu au troisième envoi : ${troisieme.messages} message(s) contre ${second.messages}.`);

  // 4. GET /session/:id/message : `agent` sur chaque message, messages `user` compris (observation de MC5).
  const messages = (await client.messages(racine.id)) ?? [];
  const infos = messages.map((m) => ({ role: m?.info?.role ?? m?.role ?? null, agent: m?.info?.agent ?? m?.agent ?? null }));
  releve(ctx, `messages de la conversation : ${JSON.stringify(infos)}`);
  exiger(infos.length >= 6, `conversation trop courte : ${infos.length} message(s) pour trois tours.`);
  const sansAgent = infos.filter((m) => typeof m.agent !== "string" || m.agent.length === 0);
  exiger(sansAgent.length === 0, `message(s) sans agent : ${resume(sansAgent)}`);
  const deUtilisateur = infos.filter((m) => m.role === "user");
  exiger(deUtilisateur.length >= 3 && deUtilisateur.every((m) => typeof m.agent === "string"), `messages « user » sans agent : ${resume(deUtilisateur)}`);
  exiger(
    infos.some((m) => m.agent === relecteur.name),
    `aucun message au nom du Relecteur : ${resume(infos.map((m) => m.agent))}`,
  );

  // 5. Le crochet de la Seconde lecture a requalifié la ligne du VRAI envoi : le composeur retrouve l'assistant précédent.
  const choix = await ctx.api.get(`/api/chat/choices/${encodeURIComponent(racine.id)}`);
  releve(ctx, `dernier choix enregistré : ${JSON.stringify(choix)}`);
  exiger(
    choix?.agent === analyste.name,
    `dernier choix « ${resume(choix?.agent)} » au lieu de « ${analyste.name} » : la ligne de la seconde lecture n'a pas été requalifiée (D-5-06).`,
  );
}
