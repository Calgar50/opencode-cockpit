// Scénario e2e de l'itération 5 (paquet L50a) : les méthodes, dans la page (spécification §5.4, §5.5, §6 l.1051 ;
// conception C §9.4, §9.8 ; plan d'exécution it5, fiches L44d et L44e).
//
// Une méthode est un TEXTE : aucun appel d'IA en plus. Ce scénario l'établit de bout en bout, en « --faux » :
//   1. un assistant avec DEUX méthodes attachées : le catalogue le dit (« Utilisée par »), et une TROISIÈME lui est
//      refusée avec la phrase de la limite — le menu « Ajouter à un assistant » de la bibliothèque la montre désactivée ;
//   2. sa fiche d'identité porte la ligne « Méthodes : … » ;
//   3. la puce « + Méthode » du composeur, AU CLAVIER SEUL (APG) : les deux méthodes déjà dans l'assistant sont
//      désactivées (« Déjà appliquée par l'assistant. »), une troisième après deux autres l'est aussi
//      (« 2 méthodes au maximum … »), et une méthode retenue se décoche ;
//   4. à l'envoi, le faux opencode reçoit le BLOC dans le corps du message, à la fin du texte écrit ;
//   5. la bulle du message montre le texte SANS le bloc et replie le bloc sous « Méthode demandée : … » ;
//   6. sous la réponse : « Méthode appliquée » quand la section attendue y est, « Méthode non détectée dans la
//      réponse » sinon — le cockpit ne contrôle que la PRÉSENCE de la section, jamais la justesse (§6 l.1051) ;
//   7. un raccourci (« /… ») désactive la puce, avec sa raison.
// Console muette et aucune violation de la CSP, comme tout scénario de la page.
import {
  attendre,
  attendreIa,
  attendreQue,
  attendreTexte,
  cliquerBouton,
  exiger,
  exigerAucuneViolationCsp,
  nonJoue,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";

/** Assistant créé par le scénario : deux méthodes attachées, droits en lecture, niveau Rapide. */
const ASSISTANT = { name: "c5a-analyste-journaux", title: "Analyste des journaux (c5a)" };

/**
 * Méthodes du catalogue livré, écrites ici en clair : c'est la spécification qu'on vérifie, pas ce que le code déclare.
 * `enTete` est ce que la méthode demande à l'IA d'écrire, et que le cockpit cherche ensuite dans sa réponse.
 */
const ATTACHEE_1 = { id: "certitude", titre: "Certitude et À VÉRIFIER" };
const ATTACHEE_2 = { id: "diagnostic-differentiel", titre: "Diagnostic différentiel" };
const DEMANDEE = { id: "clarifier-d-abord", titre: "Clarifier d'abord", enTete: "### Méthode : Clarifier d'abord" };
const SECONDE = { id: "cinq-pourquoi", titre: "5 pourquoi" };

/**
 * Assistant du catalogue livré pour lequel des méthodes sont CONSEILLÉES (`suggereePour`), jamais attachées d'office.
 * « Expliquer une alerte » est choisi parce qu'il n'a aucune fiche : le faux opencode ne sert pas `GET /skill`.
 */
const CONSEILLE = { id: "expliquer-alerte" };

/** Phrases attendues (construction-texts.ts, §4.3), écrites en clair. */
const PHRASES = {
  bibliotheque: "Une méthode guide la réponse ; elle ne garantit pas qu'elle est juste.",
  conseillees: "Méthodes conseillées",
  ajouterAssistant: "Ajouter à un assistant",
  deja: "Déjà appliquée par l'assistant.",
  trop: "2 méthodes au maximum : au-delà, l'assistant les applique moins bien.",
  raccourci: "Les méthodes ne s'ajoutent pas à un raccourci.",
  puce: "+ Méthode",
  apercu: "Ce texte sera ajouté à la fin de votre message :",
  fiche: `Méthodes : ${ATTACHEE_1.titre} · ${ATTACHEE_2.titre}`,
  demandee: `Méthode demandée : ${DEMANDEE.titre}`,
  appliquee: "Méthode appliquée",
  absente: "Méthode non détectée dans la réponse",
};

/** Marqueur du bloc ajouté au message (D-5-08), visible dans ce qui part : la bulle le replie, elle ne le cache pas. */
const MARQUEUR = `<!-- cockpit:methode-message ${DEMANDEE.id} v1 -->`;

const DEMANDE_1 = "Le traitement de nuit a plante vers 3 h.";
const DEMANDE_2 = "Et la veille, meme heure ?";

/** Réponse du faux qui APPLIQUE la méthode : la section attendue ouvre une ligne. Jetons : une ligne `usage` réelle. */
const REPONSE_AVEC = {
  text: `${DEMANDEE.enTete}\n\nVotre demande : comprendre l'arrêt de 3 h.\nQuestion bloquante : quel serveur ?`,
  cost: 0.002,
  tokens: { input: 900, output: 120, cache: { read: 0, write: 0 } },
};

/** Réponse du faux qui ne l'applique pas : aucune section, donc « non détectée ». */
const REPONSE_SANS = {
  text: "La veille, rien d'anormal : le traitement a fini a 2 h 41.",
  cost: 0.001,
  tokens: { input: 950, output: 40, cache: { read: 0, write: 0 } },
};

/** Brouillon complet d'assistant (PUT /api/assistants/:nom) ; l'assistant de création, lui, est vérifié par `npm test`. */
function brouillon(methods) {
  return {
    title: ASSISTANT.title,
    description: "Relit les journaux d'un traitement de nuit et dit ce qui reste a verifier.",
    useCase: "analyser",
    rights: "lecture",
    web: false,
    tier: "rapide",
    reflection: "standard",
    taskSize: "S",
    instructions: "Tu relis des journaux d'exploitation et tu reponds en francais, sans inventer de source.",
    fiches: [],
    examples: [],
    icon: "search",
    methods,
    name: ASSISTANT.name,
  };
}

/**
 * Déclare au faux opencode les agents qu'il sert (`e2e/fake-opencode-server.ts`, section `c5:agents-du-banc`) : le faux
 * ne lit aucun fichier, alors que le cockpit ne propose dans le composeur que les assistants qu'opencode lui rend.
 * À appeler APRÈS l'écriture du fichier d'agent : avant, le nom serait déjà pris et le cockpit en choisirait un autre.
 * Deux lignes recopiées dans `c5a-seconde-lecture.mjs` : chaque scénario reste lisible seul, et la fiche du paquet fixe
 * la liste des fichiers (aucun `c5a-commun.mjs`).
 */
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

/** État d'une ligne du popover de la puce : cochée, désactivée, raison affichée. */
async function ligneDuPopover(page, titre) {
  return await page.evaluer(`(() => {
    const item = [...document.querySelectorAll(".methodes-menu .methodes-item")].find(
      (e) => e.querySelector(".methodes-item-titre")?.textContent.trim() === ${JSON.stringify(titre)},
    );
    if (!item) return null;
    return {
      coche: item.getAttribute("aria-checked"),
      desactive: item.getAttribute("aria-disabled") ?? "false",
      raison: (item.querySelector(".methodes-item-raison")?.textContent ?? "").trim(),
    };
  })()`);
}

/** Ouvre le popover de la puce AU CLAVIER (flèche bas sur le bouton, APG « Menu Button ») : le premier élément prend le focus. */
async function ouvrirPopoverAuClavier(page) {
  await page.attendreQue("document.querySelector('.methodes-puce button:not([disabled])')", { libelle: "puce « + Méthode » active" });
  await page.evaluer(`document.querySelector(".methodes-puce button").focus()`);
  await page.touche("ArrowDown");
  await page.attendreQue("document.querySelector('.methodes-menu')", { libelle: "popover de la puce ouvert" });
}

/** Coche ou décoche une méthode AU CLAVIER : flèches bas jusqu'à elle (le menu boucle), puis Entrée. */
async function basculerAuClavier(page, titre) {
  const pas = await page.evaluer(`(() => {
    const items = [...document.querySelectorAll(".methodes-menu .methodes-item")];
    const cible = items.findIndex((e) => e.querySelector(".methodes-item-titre")?.textContent.trim() === ${JSON.stringify(titre)});
    if (cible < 0) return -1;
    const focus = items.indexOf(document.activeElement);
    return (cible - (focus < 0 ? 0 : focus) + items.length) % items.length;
  })()`);
  exiger(pas >= 0, `méthode « ${titre} » absente du popover.`);
  for (let i = 0; i < pas; i++) await page.touche("ArrowDown");
  await page.touche("Enter");
}

/** Écrit un message dans la saisie (vraies frappes, comme un utilisateur) et clique « Envoyer ». */
async function ecrireEtEnvoyer(page, texte) {
  await focaliserLaSaisie(page);
  await page.taper(texte);
  await cliquerBouton(page, "Envoyer", { portee: ".composer" });
}

async function focaliserLaSaisie(page) {
  await page.attendreQue(
    "(() => { const t = document.querySelector(\"textarea[aria-label='Message']\"); if (!t || t.disabled) return false; t.focus(); return document.activeElement === t; })()",
    { libelle: "saisie du message" },
  );
}

/** Dernier envoi reçu par le faux opencode : agent et texte des parties. */
async function dernierEnvoi(ctx) {
  const envois = (await ctx.opencodeRequests()).filter((r) => r.method === "POST" && /\/prompt_async$/.test(r.pathname));
  const dernier = envois.at(-1);
  exiger(dernier, "aucun envoi reçu par le faux opencode.");
  const parts = Array.isArray(dernier.body?.parts) ? dernier.body.parts : [];
  return { agent: dernier.body?.agent ?? null, texte: parts.map((p) => p?.text ?? "").join("") };
}

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "méthodes dans la page", "le pilotage du faux opencode (agents servis, réponses scriptées) n'existe qu'en « --faux »");
    ctx.expectNoConsoleErrors();
    return;
  }
  const ia = await attendreIa(ctx);

  // 0. Un assistant du catalogue, pour que « Méthodes conseillées » ait quelque chose à proposer : une méthode n'est
  //    conseillée que pour un assistant du catalogue RÉELLEMENT installé (rien à proposer sinon).
  const conseille = await ctx.api.post(`/api/assistants/catalogue/${CONSEILLE.id}/install`, {});
  exiger(conseille?.name === CONSEILLE.id, `assistant du catalogue non installé : ${resume(conseille)}`);

  // 1. Un assistant avec DEUX méthodes, vu ensuite par opencode comme n'importe quel assistant installé.
  const enregistre = await ctx.api.put(`/api/assistants/${ASSISTANT.name}`, brouillon([ATTACHEE_1.id, ATTACHEE_2.id]));
  exiger(enregistre?.name === ASSISTANT.name, `assistant non enregistré : ${resume(enregistre)}`);
  await declarerAgents(ctx, [{ name: ASSISTANT.name, description: "Assistant du scénario c5a-methodes", model: ia }]);
  await attendreAgentVu(ctx, ASSISTANT.name);
  const catalogue = await ctx.api.get("/api/methods");
  const utilisee = (id) => ((catalogue?.methods ?? []).find((m) => m.id === id)?.utiliseePar ?? []).map((a) => a.name);
  exiger(
    utilisee(ATTACHEE_1.id).includes(ASSISTANT.name) && utilisee(ATTACHEE_2.id).includes(ASSISTANT.name),
    `« Utilisée par » ne nomme pas l'assistant pour les deux méthodes : ${resume(utilisee(ATTACHEE_1.id))} / ${resume(utilisee(ATTACHEE_2.id))}`,
  );

  // 2. Bibliothèque des méthodes (page Assistants) : la phrase d'honnêteté, les cartes, et la TROISIÈME refusée.
  await page.evaluer(`location.hash = "#/assistants"`);
  await page.attendreQue("document.querySelector('.met-library')", { libelle: "bibliothèque des méthodes" });
  const bibliotheque = await texteVisible(page, ".met-library");
  exiger(bibliotheque.includes(PHRASES.bibliotheque), `phrase de la bibliothèque absente : ${resume(bibliotheque, 200)}`);
  exiger(bibliotheque.includes(PHRASES.conseillees), "« Méthodes conseillées » absent de la bibliothèque.");
  const suggestions = await page.evaluer("document.querySelectorAll('.met-conseils .met-suggestion').length");
  exiger(suggestions >= 1, "aucune méthode conseillée pour l'assistant du catalogue installé.");
  const cartes = await page.evaluer("document.querySelectorAll('.met-grid .met-card').length");
  exiger(cartes >= 7, `${cartes} carte(s) de méthode au lieu des 7 du catalogue livré.`);
  await page.evaluer(`document.querySelector(${JSON.stringify(`.met-card button[aria-label="${PHRASES.ajouterAssistant} : ${DEMANDEE.titre}"]`)}).click()`);
  await page.attendreQue("document.querySelector('.met-menu')", { libelle: `menu « ${PHRASES.ajouterAssistant} »` });
  const ligne = await page.evaluer(`(() => {
    const item = [...document.querySelectorAll(".met-menu-item")].find(
      (e) => e.querySelector(".met-menu-label")?.textContent.trim() === ${JSON.stringify(ASSISTANT.title)},
    );
    if (!item) return null;
    return { desactive: item.getAttribute("aria-disabled"), raison: (item.querySelector(".met-menu-reason")?.textContent ?? "").trim() };
  })()`);
  releve(ctx, `troisième méthode pour un assistant qui en a deux : ${JSON.stringify(ligne)}`);
  exiger(ligne !== null, `assistant « ${ASSISTANT.title} » absent du menu « ${PHRASES.ajouterAssistant} ».`);
  exiger(ligne.desactive === "true", "la troisième méthode n'est pas désactivée pour un assistant qui en a déjà deux.");
  exiger(ligne.raison === PHRASES.trop, `raison affichée : « ${ligne.raison} ».`);
  await page.touche("Escape");

  // 3. Fiche d'identité : la ligne « Méthodes : … », dans l'ordre du fichier d'agent.
  await page.evaluer(`location.hash = ${JSON.stringify(`#/assistants/detail/${ASSISTANT.name}`)}`);
  await page.attendreQue("document.querySelector('.modal .idc')", { libelle: "fiche d'identité de l'assistant" });
  const fiche = await texteVisible(page, ".modal .idc");
  exiger(fiche.includes(PHRASES.fiche), `fiche d'identité sans « ${PHRASES.fiche} » : ${resume(fiche, 300)}`);
  await page.evaluer(`location.hash = "#/assistants"`);

  // 4. La puce « + Méthode » au CLAVIER SEUL, dans une conversation neuve avec cet assistant.
  await ctx.faux.tourParDefaut(REPONSE_AVEC);
  await page.evaluer(`location.hash = ${JSON.stringify(`#/chat?assistant=${ASSISTANT.name}`)}`);
  await page.attendreQue(`document.querySelector(".composer-assistant select")?.value === ${JSON.stringify(ASSISTANT.name)}`, {
    libelle: "assistant du composeur",
  });
  await ouvrirPopoverAuClavier(page);
  for (const methode of [ATTACHEE_1, ATTACHEE_2]) {
    const etat = await ligneDuPopover(page, methode.titre);
    exiger(etat !== null, `méthode « ${methode.titre} » absente du popover.`);
    exiger(etat.desactive === "true" && etat.raison === PHRASES.deja, `« ${methode.titre} » : ${resume(etat)} (attendu : désactivée, « ${PHRASES.deja} »).`);
  }
  await basculerAuClavier(page, DEMANDEE.titre);
  await basculerAuClavier(page, SECONDE.titre);
  const retenues = await page.evaluer("document.querySelectorAll('.methodes-choisies .chip').length");
  exiger(retenues === 2, `${retenues} méthode(s) retenue(s) après deux Entrée au clavier.`);
  const troisieme = await page.evaluer(`(() => {
    const item = [...document.querySelectorAll(".methodes-menu .methodes-item")].find(
      (e) => e.getAttribute("aria-checked") === "false" && e.getAttribute("aria-disabled") === "true" && (e.querySelector(".methodes-item-raison")?.textContent ?? "").includes("2 méthodes"),
    );
    return item ? { titre: item.querySelector(".methodes-item-titre")?.textContent.trim(), raison: (item.querySelector(".methodes-item-raison")?.textContent ?? "").trim() } : null;
  })()`);
  releve(ctx, `troisième méthode du popover : ${JSON.stringify(troisieme)}`);
  exiger(troisieme !== null && troisieme.raison === PHRASES.trop, `aucune méthode désactivée par la limite du message : ${resume(troisieme)}`);
  // Une méthode retenue se décoche au clavier : rien n'est jamais imposé.
  await basculerAuClavier(page, SECONDE.titre);
  const apresDecochage = await page.evaluer("document.querySelectorAll('.methodes-choisies .chip').length");
  exiger(apresDecochage === 1, `${apresDecochage} méthode(s) retenue(s) après décochage.`);
  // Échap ferme le popover et rend le focus au bouton (APG).
  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.methodes-menu')", { libelle: "popover fermé par Échap" });
  const focus = await page.focus();
  exiger(focus.includes(PHRASES.puce), `focus sur « ${focus} » au lieu du bouton de la puce après Échap.`);
  const apercu = await texteVisible(page, ".methodes-choisies");
  exiger(apercu.includes(PHRASES.apercu), `aperçu absent des méthodes retenues : ${resume(apercu, 200)}`);

  // 5. Envoi : le faux reçoit le bloc à la fin du texte écrit, et le corps porte l'assistant choisi.
  await ecrireEtEnvoyer(page, DEMANDE_1);
  await attendreQue(
    async () => {
      const envoi = await dernierEnvoi(ctx).catch(() => null);
      return envoi && envoi.texte.includes(MARQUEUR) ? envoi : false;
    },
    { delaiMs: 20_000, libelle: "envoi avec le bloc de méthode reçu par le faux opencode" },
  );
  const envoi = await dernierEnvoi(ctx);
  releve(ctx, `corps reçu par le faux : agent ${envoi.agent}, ${envoi.texte.length} caractères`);
  exiger(envoi.agent === ASSISTANT.name, `envoi fait avec l'agent « ${envoi.agent} ».`);
  exiger(envoi.texte.startsWith(DEMANDE_1), "le texte écrit n'ouvre plus le message.");
  exiger(envoi.texte.includes(`## ${PHRASES.demandee}`), "le bloc envoyé ne porte pas l'en-tête de la méthode demandée.");

  // 6. Bulle repliée : le texte écrit sans le bloc, le bloc replié dessous.
  await page.attendreQue("document.querySelector('.methode-bulle')", { libelle: "bulle de la méthode demandée" });
  const bulle = await page.evaluer(`(() => {
    const d = document.querySelector(".methode-bulle");
    const msg = d.closest(".user-msg");
    return {
      repliee: d.open === false,
      resume: (d.querySelector("summary")?.textContent ?? "").trim(),
      texteVisible: (msg?.innerText ?? "").replace(/\\s+/g, " ").trim(),
    };
  })()`);
  releve(ctx, `bulle : ${JSON.stringify(bulle)}`);
  exiger(bulle.repliee, "la bulle de la méthode n'est pas repliée.");
  exiger(bulle.resume === PHRASES.demandee, `résumé de la bulle : « ${bulle.resume} ».`);
  exiger(!bulle.texteVisible.includes(MARQUEUR), "le marqueur du bloc est affiché dans la bulle du message.");

  // 7. Sous la réponse : « Méthode appliquée », puis « non détectée » quand la section manque.
  await attendreTexte(page, PHRASES.appliquee, { selecteur: ".chat-thread", delaiMs: 30_000 });
  const presente = await page.evaluer(
    `(() => { const p = document.querySelector(".methode-presence"); return p ? { etat: p.getAttribute("data-presente"), texte: p.textContent.trim() } : null; })()`,
  );
  releve(ctx, `présence de la méthode : ${JSON.stringify(presente)}`);
  exiger(presente?.etat === "oui", `présence relevée : ${resume(presente)}`);

  await ctx.faux.tourParDefaut(REPONSE_SANS);
  await ouvrirPopoverAuClavier(page);
  await basculerAuClavier(page, DEMANDEE.titre);
  await page.touche("Escape");
  await ecrireEtEnvoyer(page, DEMANDE_2);
  await attendreTexte(page, PHRASES.absente, { selecteur: ".chat-thread", delaiMs: 30_000 });
  const presences = await page.evaluer(`[...document.querySelectorAll(".methode-presence")].map((p) => p.getAttribute("data-presente"))`);
  releve(ctx, `présences relevées après deux demandes : ${JSON.stringify(presences)}`);
  exiger(presences.includes("oui") && presences.includes("non"), `présences : ${resume(presences)} (une appliquée, une non détectée attendues).`);

  // 8. Raccourci : la puce est désactivée, avec sa raison.
  await focaliserLaSaisie(page);
  await page.taper("/resume");
  await attendre(300);
  const puce = await page.evaluer(
    `(() => { const b = document.querySelector(".methodes-puce button"); return b ? { desactive: b.disabled, titre: b.getAttribute("title") } : null; })()`,
  );
  releve(ctx, `puce pendant un raccourci : ${JSON.stringify(puce)}`);
  exiger(puce?.desactive === true, "la puce reste active alors que le message est un raccourci.");
  exiger(puce.titre === PHRASES.raccourci, `infobulle de la puce : « ${puce.titre} ».`);

  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}
