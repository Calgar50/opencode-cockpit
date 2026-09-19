// Scénario e2e de l'itération 1 (L7b-2) : mesure M1, deux messages `noReply` consécutifs puis une réponse.
//
// Spécification §8 M1 (« Copilot (Claude, GPT) accepte deux messages utilisateur noReply consécutifs puis une réponse » : e2e L7 puis
// recette ; repli : carte seule + [Ajouter à la conversation]), §7.3 L7 (« noReply consécutifs »), F-h (noReply enregistre le message
// sans lancer de tour, oc/session/prompt.ts:1069), F11. Décisions D-12 (toute exécution réelle demande l'accord explicite de
// l'utilisateur, budget annoncé) et n° 2 du 19/09 (Copilot réel : non ; recettes facturées consignées « en attente »).
//
// La mesure porte sur l'IA réelle : elle n'est jouée qu'en « --reel », ET avec l'accord écrit de l'utilisateur pour CETTE recette
// (E2E_ACCORD_FACTURE contenant « M1 »), pour chacune des IA Copilot nommées dans E2E_M1_IA (liste séparée par des virgules, par
// défaut la première IA Claude et la première IA GPT du catalogue du cockpit). Budget : trois envois par IA, dont un seul appelle
// l'IA (les deux noReply n'en appellent aucune), plus le titre de la conversation.
//
// Hors de ce cas, la recette est annoncée « non jouée (en attente) ». En « --faux » et en « --reel-hors-ligne », une RÉPÉTITION sans
// IA réelle vérifie la mécanique que la recette emploie, par le proxy du cockpit : deux envois noReply acceptés (204) qui n'ouvrent
// aucun tour (aucune réponse, aucune session occupée), puis un envoi ordinaire qui obtient une réponse après les trois messages de
// l'utilisateur, dans l'ordre. Elle ne mesure PAS M1 : ni le faux opencode ni le faux fournisseur ne sont une IA Copilot.
// La répétition et la recette tournent sous le témoin P6 et P4 ; l'annonce « non jouée » seule n'agit pas sur opencode.
import { attendreFinDuTour, attendreIa, avecTemoinP6, exiger, exigerListe, nonJoue, oc, releve, resume } from "./it1-ui-commun.mjs";

const TEXTES = ["Premier message déposé sans réponse.", "Second message déposé sans réponse.", "Réponds seulement : bien reçu."];

export async function run(ctx) {
  const accord = String(process.env.E2E_ACCORD_FACTURE ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes("M1");
  if (ctx.mode === "reel" && accord) {
    await avecTemoinP6(ctx, () => recette(ctx));
    return;
  }
  nonJoue(
    ctx,
    "M1 (deux messages noReply consécutifs puis une réponse, sur Copilot réel)",
    ctx.mode === "reel" ? "accord E2E_ACCORD_FACTURE=M1 absent : recette facturée en attente" : "recette facturée en attente (décision n° 2 du 19/09)",
  );
  if (ctx.mode === "reel") return;
  const libelle = ctx.mode === "faux" ? "répétition sans IA (faux opencode)" : "répétition sans IA réelle (vrai opencode, faux fournisseur)";
  await avecTemoinP6(ctx, async () => repetition(ctx, await attendreIa(ctx), libelle));
}

/** Deux envois noReply, puis un envoi ordinaire ; rend les messages de la conversation à la fin du tour. */
async function troisEnvois(ctx, ia, titre) {
  const client = oc(ctx);
  const racine = await client.creerConversation(titre);
  for (const texte of TEXTES.slice(0, 2)) {
    const reponse = await ctx.api.brut("POST", `/api/oc/session/${encodeURIComponent(racine.id)}/prompt_async?directory=${encodeURIComponent(client.dossier)}`, {
      agent: "build",
      model: ia,
      noReply: true,
      parts: [{ type: "text", text: texte }],
    });
    exiger(reponse.code === 204, `envoi noReply refusé (${reponse.code}) : ${resume(reponse.corps)}`);
  }
  const apresNoReply = await attendreDeuxMessages(client, racine.id);
  exiger(apresNoReply.every((m) => m.info?.role === "user"), `réponse d'assistant après les envois noReply : ${resume(apresNoReply.map((m) => m.info?.role))}`);
  const etats = (await client.etats()) ?? {};
  exiger(!etats[racine.id] || etats[racine.id].type === "idle", `tour ouvert par un envoi noReply : ${resume(etats[racine.id])}`);
  const envoi = await client.envoyer(racine.id, TEXTES[2], ia);
  exiger(envoi.code === 204, `envoi ordinaire refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  return { racine, messages: await attendreFinDuTour(client, racine.id, { delaiMs: 120_000 }) };
}

/** Messages d'une conversation dès qu'il y en a deux (les envois noReply sont enregistrés sans tour). */
async function attendreDeuxMessages(client, sessionId) {
  const limite = Date.now() + 15_000;
  let messages = [];
  while (Date.now() < limite) {
    messages = (await client.messages(sessionId)) ?? [];
    if (messages.length >= 2) return messages;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`messages noReply non enregistrés : ${resume(messages.map((m) => m.info?.role))}`);
}

/** Répétition sans IA (« --faux ») : la mécanique de la recette, par le proxy du cockpit. */
async function repetition(ctx, ia, libelle) {
  const { messages } = await troisEnvois(ctx, ia, "it1-ui-m1-repetition");
  const roles = messages.map((m) => m.info?.role);
  exigerListe(roles, ["user", "user", "user", "assistant"], "messages de la conversation");
  const derniere = messages.at(-1);
  exiger(!derniere.info?.error, `réponse en erreur : ${resume(derniere.info?.error)}`);
  releve(ctx, `${libelle} : deux envois noReply acceptés sans tour, puis une réponse après trois messages de l'utilisateur (ne mesure pas M1)`);
}

/** Recette M1 sur Copilot réel (« --reel » avec accord) : une conversation par IA nommée. */
async function recette(ctx) {
  const bootstrap = await ctx.api.get("/api/bootstrap");
  const copilot = (bootstrap.models ?? []).filter((m) => m.providerID === "github-copilot");
  const noms = String(process.env.E2E_M1_IA ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const choisies = noms.length > 0 ? noms : [copilot.find((m) => /claude/i.test(m.modelID))?.modelID, copilot.find((m) => /gpt/i.test(m.modelID))?.modelID].filter(Boolean);
  exiger(choisies.length > 0, "aucune IA Copilot au catalogue pour la recette M1.");
  for (const modelID of choisies) {
    exiger(copilot.some((m) => m.modelID === modelID), `IA « ${modelID} » absente du catalogue Copilot du cockpit.`);
    const ia = { providerID: "github-copilot", modelID };
    const { messages } = await troisEnvois(ctx, ia, `it1-ui-m1-${modelID}`);
    const derniere = messages.at(-1);
    const texte = (derniere?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
    exiger(derniere?.info?.role === "assistant" && !derniere.info.error && texte !== "", `M1 sur ${modelID} : ${resume(derniere?.info?.error ?? "réponse vide")} (repli : carte seule + [Ajouter à la conversation]).`);
    releve(ctx, `M1 sur github-copilot/${modelID} : deux noReply consécutifs acceptés, puis une réponse (${texte.length} caractères)`);
  }
}
