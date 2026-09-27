// Scénario e2e de l'itération 5 (paquet L50a) : la Seconde lecture, dans la page (spécification §2.1 l.65 ;
// conception C §9.7 ; recherche RM §5.4 ; plan d'exécution it5 D-5-06, D-5-22, A5, réponse Q1 (a), fiches L44c et L44e).
//
// Voie principale, tenue par la mesure MC5-1 (train de V0 de 5a) : une seconde lecture est un message ORDINAIRE envoyé
// au « Relecteur critique » DANS LA MÊME conversation. Ce scénario l'établit en « --faux » :
//   1. Relecteur absent : la phrase du §4.3 et [Installer], jamais de bouton chiffré ;
//   2. installation par le catalogue existant, au clic ;
//   3. bouton « Seconde lecture (≈ … $) » : « ≈ », JAMAIS « au moins » (D-5-22), et l'infobulle nomme l'IA du Relecteur
//      puis la base de l'estimation (A5) ;
//   4. au clic, le faux opencode reçoit UN envoi, avec l'agent du Relecteur et la phrase EXACTE du §4.3 ;
//   5. sous sa réponse, le pied dit ce que cette relecture ne remplace pas ;
//   6. à la réouverture de la conversation, le composeur a gardé l'assistant PRÉCÉDENT : la ligne `chat_turns` de la
//      seconde lecture a été requalifiée, elle n'est pas le dernier choix de la personne (D-5-06).
// Console muette et aucune violation de la CSP.
import {
  attendreFinDuTour,
  attendreIa,
  attendreQue,
  attendreTexte,
  boutonVisible,
  cliquerBouton,
  exiger,
  exigerAucuneViolationCsp,
  nonJoue,
  oc,
  ouvrirConversation,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";

/** Assistant de la conversation : c'est lui que le composeur doit retrouver après la seconde lecture. */
const REDACTEUR = { name: "c5a-redacteur-runbook", title: "Rédacteur de runbook (c5a)" };
/** Identifiant de catalogue du Relecteur critique (construction-constants.ts) : sans lui, aucune seconde lecture. */
const RELECTEUR = "relecteur-critique";

/** Phrases attendues (construction-texts.ts, §4.3), écrites en clair. */
const PHRASES = {
  absente: "Installez l'assistant « Relecteur critique » pour demander une seconde lecture.",
  installer: "Installer",
  infobulleDebut: "Un autre assistant (Relecteur critique, ",
  infobulleFin: "relit la réponse avec une liste de contrôle. Il voit toute la conversation : le coût dépend de sa longueur.",
  base: "Estimation d'après la longueur actuelle de la conversation.",
  pied: "Relecture par un autre assistant : elle ne remplace ni la relecture par un collègue ni le CAB.",
  message: (assistant) =>
    `Seconde lecture de la réponse précédente de « ${assistant} ». Vérifie-la avec ta liste de contrôle. Relis les fichiers cités si tu y as accès. Ne change pas une conclusion sourcée sans fait nouveau.`,
};

/** Libellé du bouton : « ≈ », un montant, et jamais un minimum (D-5-22). */
const LIBELLE = /^Seconde lecture \(≈ .+\$\)$/;

const DEMANDE_1 = "Ecris le runbook de la bascule de nuit.";
const DEMANDE_2 = "Ajoute l'etape de verification finale.";

/** Réponses du faux, avec des jetons : la base « conversation » de l'estimation se lit dans la dernière ligne `usage`. */
const REPONSE = { text: "Runbook en trois etapes : arret, bascule, controle.", cost: 0.003, tokens: { input: 1800, output: 260, cache: { read: 0, write: 0 } } };
const RELECTURE = { text: "Rien a reprendre sur les deux premieres etapes ; la troisieme manque de controle.", cost: 0.002, tokens: { input: 2100, output: 90, cache: { read: 0, write: 0 } } };

/** Brouillon complet d'assistant (PUT /api/assistants/:nom). */
function brouillon() {
  return {
    title: REDACTEUR.title,
    description: "Redige des runbooks d'exploitation a partir de ce que la personne decrit.",
    useCase: "rediger",
    rights: "lecture",
    web: false,
    tier: "rapide",
    reflection: "standard",
    taskSize: "S",
    instructions: "Tu rediges des runbooks clairs, etape par etape, en francais, sans inventer de commande.",
    fiches: [],
    examples: [],
    icon: "edit",
    methods: [],
    name: REDACTEUR.name,
  };
}

/** Déclare au faux opencode les agents qu'il sert (`e2e/fake-opencode-server.ts`, section `c5:agents-du-banc`). */
async function declarerAgents(ctx, agents) {
  await ctx.faux.scripter("banc:agents", { agents });
}

/** Attend que le cockpit voie cet agent (cache de 15 s d'`oc-lookup`) : la résolution ne signale plus de repli. */
async function attendreAgentVu(ctx, nom, dossier = "/workspace") {
  return await attendreQue(
    async () => {
      const resolu = await ctx.api.post("/api/chat/resolve", { directory: dossier, agent: nom });
      return resolu?.agent === nom && resolu?.agentMissing === null ? resolu : false;
    },
    { delaiMs: 30_000, pasMs: 1_000, libelle: `agent « ${nom} » vu par le cockpit` },
  );
}

/**
 * Confirmations de la garde « réponse en cours » (`reloadGuard`) : le banc n'a aucune réponse en cours, mais opencode
 * peut ne pas permettre de le vérifier. La confirmation est alors donnée, comme le ferait la personne.
 */
async function confirmerSiDemande(page) {
  for (const libelle of ["Interrompre et continuer", "Continuer quand même"]) {
    if (await boutonVisible(page, libelle, ".modal")) {
      await cliquerBouton(page, libelle, { portee: ".modal" });
      return libelle;
    }
  }
  return null;
}

/**
 * Pose d'avance la FICHE du Relecteur. Le faux opencode ne sert pas `GET /skill` : la vérification d'une fiche neuve
 * échoue donc, APRÈS son écriture (un retour arrière n'a lieu que sur un refus de configuration, pas sur une route
 * inconnue), et l'assistant n'est alors pas créé. Une première tentative d'installation laisse ainsi la fiche en place ;
 * le clic [Installer] du scénario est ensuite celui d'une personne, sans refus qui ne viendrait que du banc. Si le faux
 * sait un jour servir cette route, l'installation aboutit ici : l'assistant est alors retiré, et le scénario reprend au
 * même point.
 */
async function poserLaFicheDuRelecteur(ctx) {
  const reponse = await ctx.api.brut("POST", `/api/assistants/catalogue/${RELECTEUR}/install`, {});
  releve(ctx, `fiche du Relecteur posée d'avance (code ${reponse.code})`);
  const installe = ((await ctx.api.get("/api/assistants"))?.assistants ?? []).find((a) => a.name === RELECTEUR || a.catalogId === RELECTEUR);
  if (!installe) return;
  const retrait = await ctx.api.brut("DELETE", `/api/assistants/${installe.name}?force=1`);
  exiger(retrait.code === 200, `assistant installé par la pose de la fiche et non retiré (${retrait.code}) : le scénario ne prouverait plus rien.`);
}

/** Bouton de la Seconde lecture sous la DERNIÈRE réponse : son libellé et son infobulle. */
async function boutonSecondeLecture(page) {
  return await page.evaluer(`(() => {
    const zones = [...document.querySelectorAll(".seconde-lecture")];
    const zone = zones[zones.length - 1];
    const bouton = zone?.querySelector("button");
    if (!bouton) return null;
    return { libelle: bouton.textContent.replace(/\\s+/g, " ").trim(), infobulle: bouton.getAttribute("title") ?? "", desactive: bouton.disabled };
  })()`);
}

/** Envois reçus par le faux opencode, dans l'ordre : agent et texte de la première partie. */
async function envois(ctx) {
  return (await ctx.opencodeRequests())
    .filter((r) => r.method === "POST" && /\/prompt_async$/.test(r.pathname))
    .map((r) => ({
      agent: r.body?.agent ?? null,
      texte: (Array.isArray(r.body?.parts) ? r.body.parts : []).map((p) => p?.text ?? "").join(""),
    }));
}

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "seconde lecture dans la page", "le pilotage du faux opencode (agents servis, réponses scriptées) n'existe qu'en « --faux »");
    ctx.expectNoConsoleErrors();
    return;
  }
  const ia = await attendreIa(ctx);
  const client = oc(ctx);

  // 0. Fiche du Relecteur posée d'avance (limite du faux opencode, voir `poserLaFicheDuRelecteur`).
  await poserLaFicheDuRelecteur(ctx);

  // 1. Un assistant, une conversation, un tour terminé : il y a quelque chose à relire, et une ligne `usage` à lire.
  const enregistre = await ctx.api.put(`/api/assistants/${REDACTEUR.name}`, brouillon());
  exiger(enregistre?.name === REDACTEUR.name, `assistant non enregistré : ${resume(enregistre)}`);
  await declarerAgents(ctx, [{ name: REDACTEUR.name, description: "Assistant du scénario c5a-seconde-lecture", model: ia }]);
  await attendreAgentVu(ctx, REDACTEUR.name);
  await ctx.faux.tourParDefaut(REPONSE);
  const racine = await client.creerConversation("c5a-seconde-lecture");
  const envoi = await client.envoyer(racine.id, DEMANDE_1, ia, REDACTEUR.name);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreFinDuTour(client, racine.id);
  await ouvrirConversation(ctx, racine.id);

  // 2. Relecteur absent : la phrase et [Installer], aucun montant.
  await attendreTexte(page, PHRASES.absente, { selecteur: ".chat-thread", delaiMs: 20_000 });
  exiger(await boutonVisible(page, PHRASES.installer, ".seconde-lecture"), "[Installer] absent alors que le Relecteur n'est pas installé.");
  const avant = await boutonSecondeLecture(page);
  releve(ctx, `Relecteur absent : ${JSON.stringify(avant)}`);
  exiger(!LIBELLE.test(avant?.libelle ?? ""), `un bouton chiffré est proposé sans Relecteur : « ${avant?.libelle} ».`);

  // 3. Installation au clic, par le catalogue existant.
  await cliquerBouton(page, PHRASES.installer, { portee: ".seconde-lecture" });
  let dernierMessage = "";
  const installe = await attendreQue(
    async () => {
      // La garde « réponse en cours » peut demander une confirmation : le banc n'a aucune réponse en cours, on la donne.
      await confirmerSiDemande(page);
      const liste = (await ctx.api.get("/api/assistants"))?.assistants ?? [];
      const trouve = liste.find((a) => a.name === RELECTEUR || a.catalogId === RELECTEUR);
      if (trouve) return trouve;
      dernierMessage = await texteVisible(page, ".toast-stack");
      return false;
    },
    { delaiMs: 60_000, pasMs: 1_000, libelle: "assistant « Relecteur critique » installé" },
  ).catch((err) => {
    throw new Error(`${err.message}${dernierMessage ? ` — message affiché : « ${resume(dernierMessage, 200)} »` : ""}`);
  });
  releve(ctx, `Relecteur installé : ${installe.name} (${installe.title})`);
  // Le faux ne lit aucun fichier : c'est le banc qui lui dit qu'opencode sert désormais cet agent (section `c5:agents-du-banc`).
  await declarerAgents(ctx, [
    { name: REDACTEUR.name, description: "Assistant du scénario c5a-seconde-lecture", model: ia },
    { name: RELECTEUR, description: installe.description ?? "Relecteur critique", model: ia },
  ]);
  await attendreAgentVu(ctx, RELECTEUR);

  // 4. Un second tour : la page relit l'estimation, et le bouton chiffré paraît.
  const envoi2 = await client.envoyer(racine.id, DEMANDE_2, ia, REDACTEUR.name);
  exiger(envoi2.code === 204, `second envoi refusé (${envoi2.code}) : ${resume(envoi2.corps)}`);
  await attendreFinDuTour(client, racine.id);
  const bouton = await attendreQue(
    async () => {
      const vu = await boutonSecondeLecture(page);
      return vu && LIBELLE.test(vu.libelle) ? vu : false;
    },
    { delaiMs: 40_000, pasMs: 500, libelle: "bouton « Seconde lecture (≈ … $) »" },
  );
  releve(ctx, `bouton : ${JSON.stringify(bouton)}`);
  exiger(!bouton.libelle.includes("au moins"), `le libellé promet un minimum : « ${bouton.libelle} ».`);
  exiger(bouton.infobulle.startsWith(PHRASES.infobulleDebut), `infobulle : « ${bouton.infobulle} ».`);
  exiger(bouton.infobulle.includes(PHRASES.infobulleFin), `infobulle sans la phrase du coût : « ${bouton.infobulle} ».`);
  exiger(bouton.infobulle.endsWith(PHRASES.base), `infobulle sans la base de l'estimation : « ${bouton.infobulle} ».`);

  // 5. Clic : UN envoi, avec l'agent du Relecteur et la phrase exacte.
  await ctx.faux.tourParDefaut(RELECTURE);
  const avantClic = (await envois(ctx)).length;
  await page.evaluer(`(() => { const z = [...document.querySelectorAll(".seconde-lecture")]; z[z.length - 1].querySelector("button").click(); })()`);
  const attendu = PHRASES.message(REDACTEUR.name);
  const relecture = await attendreQue(
    async () => {
      const liste = (await envois(ctx)).slice(avantClic);
      return liste.length > 0 ? liste : false;
    },
    { delaiMs: 30_000, libelle: "envoi de la seconde lecture reçu par le faux opencode" },
  );
  releve(ctx, `envois après le clic : ${resume(relecture.map((e) => e.agent))}`);
  exiger(relecture.length === 1, `${relecture.length} envoi(s) pour une seconde lecture (un seul attendu, P5).`);
  exiger(relecture[0].agent === RELECTEUR, `envoi fait avec l'agent « ${relecture[0].agent} ».`);
  exiger(relecture[0].texte === attendu, `phrase reçue : « ${resume(relecture[0].texte, 200)} ».`);

  // 6. Pied sous la réponse du Relecteur.
  await attendreTexte(page, PHRASES.pied, { selecteur: ".chat-thread", delaiMs: 40_000 });

  // 7. Réouverture : le composeur retrouve l'assistant PRÉCÉDENT, pas le Relecteur.
  const choix = await ctx.api.get(`/api/chat/choices/${racine.id}`);
  releve(ctx, `dernier choix enregistré : ${JSON.stringify(choix)}`);
  exiger(choix?.agent === REDACTEUR.name, `dernier choix : ${resume(choix)} (l'assistant précédent était attendu).`);
  await page.evaluer(`location.hash = "#/assistants"`);
  await page.attendreQue("!document.querySelector('.chat-thread')", { libelle: "conversation quittée" });
  await ouvrirConversation(ctx, racine.id);
  await page.attendreQue(`document.querySelector(".composer-assistant select")?.value === ${JSON.stringify(REDACTEUR.name)}`, {
    delaiMs: 20_000,
    libelle: "assistant précédent retrouvé par le composeur",
  });

  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}
