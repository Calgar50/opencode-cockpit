// Scénario e2e de l'itération 5 (paquet L50b) : la forme AIGUILLAGE de bout en bout, sur l'exemple « Tri d'une alerte »
// (spécification §5.3, §6 ; conception C §17.3 n° 4 ; plan d'exécution it5, fiches L42a à L42c, D-5-13).
//
// Ce que le scénario établit, dans la vraie pile, sur le faux opencode :
//   1. l'aiguilleur propose, et le lancement passe en « attente-choix » : AUCUN spécialiste n'est lancé avant votre
//      confirmation — aucun envoi ne part tant que la réponse n'est pas venue (c'est le point de P3 : « vous confirmez son
//      choix », jamais « le cockpit a choisi ») ;
//   2. la CARTE DE CHOIX se tient AU CLAVIER : la proposition de l'aiguilleur est présélectionnée et dite comme une
//      proposition d'IA à vérifier, une case se coche et se décoche au clavier, et [Continuer avec …] part de là ;
//   3. les spécialistes ÉCARTÉS passent à « Non choisi », état final SANS coût : ils n'ont jamais rien envoyé ;
//   4. le chemin « AUCUN ne convient » (D-5-13), choisi AU CLAVIER sur la carte : rien n'est envoyé, le livrable porte la
//      phrase du refus et nomme l'assistant de repli, et [Envoyer à cet assistant] PRÉREMPLIT le composeur — la demande et
//      l'assistant de repli — sans RIEN envoyer : aucune requête vers opencode, aucun coût ajouté.
// En « --reel-hors-ligne », les étapes ne sont pas scriptables : le scénario le dit et ne joue rien.
import { attendre, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { preparerPage } from "./it1-ui-commun.mjs";
import { attendreRun, enAvance, equipes, ouvrirLaConversation, repere, requetesDepuis, scripterEtape } from "./it4-commun.mjs";
import { arreterLesLancements, equipeDeriveeC5, lancerAvec } from "./c5b-relecture.mjs";

/**
 * Exemple éprouvé ici, en DEUX copies : un lancement par copie. Les scripts du faux se posent par identifiant d'étape et
 * s'AJOUTENT (`FakeOpencode.script`) ; deux lancements qui partagent l'identifiant de l'aiguilleur rejoueraient la même
 * file de tours, et le second verrait la proposition du premier (mesuré au banc). Chaque copie a donc ses identifiants.
 */
const EXEMPLE = "tri-alerte";
const AIGUILLEUR = "aiguilleur";
const SYNTHESE = "synthese";
/** Titre du spécialiste proposé, écrit en clair : c'est par le TITRE que l'aiguilleur nomme son choix (flow.ts, `readChoice`). */
const RETENU = { id: "reseau", titre: "Réseau et accès" };
const ECARTES = ["supervision", "base-de-donnees", "application", "stockage"];

/** Demandes des deux lancements : reconnaissables, et différentes l'une de l'autre. */
const ALERTE = "Alerte : latence anormale sur la passerelle de paiement depuis 3 h.";
const ALERTE_HORS_LISTE = "Alerte : le bâtiment n'a plus de badge d'accès depuis ce matin.";

/** Phrases attendues (construction-texts.ts `partout.execution`), écrites en clair. */
const PHRASES = {
  titre: "Choisissez le ou les spécialistes",
  verifiez: "C'est la proposition d'une IA : vérifiez-la.",
  maximum: "2 au maximum.",
  aucunConvient: "Aucun ne convient",
  gratuite: "Rien n'est facturé pendant la pause.",
  aucun: "Aucun spécialiste de la liste ne convient.",
  envoyer: "Envoyer à cet assistant",
  nonChoisi: "Non choisi",
};

/** Réponse de l'aiguilleur : la raison, puis la ligne « CHOIX: » SEULE, en dernier. */
const PROPOSE = {
  text: `La latence porte sur un lien entre deux sites.\n\nCHOIX: ${RETENU.titre}`,
  cost: 0.004,
  tokens: { input: 400, output: 60, cache: { read: 0, write: 0 } },
  stepMs: 5,
};
/** Réponse de l'aiguilleur quand la liste fermée ne couvre pas l'alerte : « CHOIX: aucun », donc rien n'est envoyé ensuite. */
const PROPOSE_AUCUN = {
  text: "Cette alerte ne relève d'aucun des cinq domaines proposés.\n\nCHOIX: aucun",
  cost: 0.003,
  tokens: { input: 380, output: 40, cache: { read: 0, write: 0 } },
  stepMs: 5,
};
const SPECIALISTE = {
  text: "Regarder en lecture seule : temps de réponse du lien, pertes, certificat de la passerelle.",
  cost: 0.006,
  tokens: { input: 500, output: 90, cache: { read: 0, write: 0 } },
  stepMs: 5,
};

const envois = (requetes) => requetes.filter((requete) => requete.method === "POST" && requete.pathname.endsWith("/prompt_async"));

/** État de la carte de choix dans la page : cases, présélection, boutons. */
const carteDeChoix = `(() => {
  const carte = document.querySelector(".team-choice");
  if (!carte) return null;
  return {
    titre: (carte.querySelector(".team-pause-title")?.textContent ?? "").trim(),
    texte: (carte.innerText ?? "").replace(/\\s+/g, " ").trim(),
    cases: [...carte.querySelectorAll(".team-choice-item")].map((item) => ({
      libelle: (item.querySelector("label")?.textContent ?? "").trim(),
      cochee: item.querySelector("input[type=checkbox]")?.checked === true,
    })),
    boutons: [...carte.querySelectorAll(".team-card-actions button")].map((b) => b.textContent.trim()),
  };
})()`;

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "aiguillage de bout en bout", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }
  const page = await preparerPage(ctx);
  const lancements = [];
  let apiDuScenario = null;

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    apiDuScenario = api;
    const copieA = await equipeDeriveeC5(api, EXEMPLE, "aig");

    const bloc = copieA.flow.blocs.find((candidat) => candidat.type === "aiguillage");
    exiger(bloc !== undefined, `l'exemple « ${EXEMPLE} » ne porte pas de bloc « aiguillage » : ${resume(copieA.flow.blocs.map((b) => b.type))}`);
    exiger(bloc.choixMax === 2, `choixMax vaut ${bloc.choixMax} au lieu de 2.`);
    exiger(bloc.specialistes.length === 5, `${bloc.specialistes.length} spécialiste(s) au lieu de 5.`);
    exiger(typeof bloc.repli === "string" && bloc.repli !== "", "l'exemple ne nomme aucun assistant de repli (D-5-13).");
    const retenuA = bloc.specialistes.find((step) => step.id === `${RETENU.id}-aig`);
    exiger(retenuA?.titre === RETENU.titre, `titre du spécialiste « ${RETENU.id} » : « ${retenuA?.titre} ».`);
    const ecartesA = ECARTES.map((id) => `${id}-aig`);

    await scripterEtape(ctx, retenuA.id, SPECIALISTE);

    // --- Lancement A : la proposition est confirmée au clavier -----------------------------------------------------------
    await scripterEtape(ctx, `${AIGUILLEUR}-aig`, PROPOSE);
    const { runId: runA, rootId: racineA, estimation: estimationA } = await lancerAvec(api, copieA.id, ALERTE);
    lancements.push(runA);
    exiger(estimationA.estimate?.repetitions?.specialistes === 2, `l'estimation annonce ${resume(estimationA.estimate?.repetitions?.specialistes)} spécialiste(s) au plus au lieu de 2.`);

    // 1. Attente du choix, et AUCUN spécialiste lancé avant votre confirmation.
    const attente = await attendreRun(api, runA, (vue) => vue.state === "attente-choix", "aiguillage en attente de votre choix");
    exiger(attente.pause?.kind === "choix", `pause de genre « ${attente.pause?.kind} » au lieu de « choix ».`);
    exiger((attente.pause.choix ?? []).length === 5, `${(attente.pause.choix ?? []).length} spécialiste(s) proposé(s) au lieu de 5.`);
    const proposes = (attente.pause.choix ?? []).filter((option) => option.propose).map((option) => option.stepId);
    exiger(proposes.length === 1 && proposes[0] === retenuA.id, `proposition lue : ${resume(proposes)} (« ${retenuA.id} » attendu).`);
    const etatA = (stepId) => attente.steps.find((step) => step.stepId === stepId)?.state ?? "absente";
    for (const stepId of [retenuA.id, ...ecartesA, `${SYNTHESE}-aig`]) {
      exiger(etatA(stepId) !== "en-cours" && etatA(stepId) !== "terminee", `l'étape « ${stepId} » travaille avant votre confirmation : « ${etatA(stepId)} ».`);
    }
    const avantChoix = await repere(ctx);
    await attendre(600);
    const pendantLAttente = envois(await requetesDepuis(ctx, avantChoix));
    exiger(pendantLAttente.length === 0, `${pendantLAttente.length} envoi(s) pendant l'attente du choix : ${resume(pendantLAttente.map((r) => r.pathname))}`);
    releve(ctx, "aiguillage : aucun spécialiste lancé avant la confirmation, aucun envoi pendant l'attente");

    // 2. La carte de choix, AU CLAVIER : la proposition est présélectionnée, une case se coche et se décoche, puis [Continuer].
    await ouvrirLaConversation(ctx, racineA);
    await page.attendreQue("document.querySelector('.team-choice')", { delaiMs: 25_000, libelle: "carte de choix de l'aiguillage" });
    const carte = await page.evaluer(carteDeChoix);
    releve(ctx, `carte de choix : ${JSON.stringify(carte)}`);
    exiger(carte.titre === PHRASES.titre, `titre de la carte : « ${carte.titre} ».`);
    exiger(carte.texte.includes(PHRASES.verifiez), `la carte ne dit pas que la proposition est celle d'une IA : ${resume(carte.texte, 400)}`);
    exiger(carte.texte.includes(PHRASES.maximum), `la carte ne dit pas « ${PHRASES.maximum} » : ${resume(carte.texte, 400)}`);
    exiger(carte.texte.includes(PHRASES.gratuite), `la carte ne dit pas la gratuité de la pause : ${resume(carte.texte, 400)}`);
    exiger(carte.cases.length === 5, `${carte.cases.length} case(s) au lieu de 5.`);
    const cocheesAuDepart = carte.cases.filter((c) => c.cochee).map((c) => c.libelle);
    exiger(cocheesAuDepart.length === 1 && cocheesAuDepart[0] === RETENU.titre, `cases cochées au départ : ${resume(cocheesAuDepart)}.`);
    exiger(carte.boutons.some((mot) => mot.includes(PHRASES.aucunConvient)), `boutons de la carte : ${resume(carte.boutons)}.`);

    // Au clavier seul : la case d'un autre spécialiste se coche, puis se décoche ; rien n'est imposé.
    const focaliser = (libelle) => `(() => {
      const item = [...document.querySelectorAll(".team-choice-item")].find((e) => (e.querySelector("label")?.textContent ?? "").trim() === ${JSON.stringify(libelle)});
      const boite = item?.querySelector("input[type=checkbox]");
      if (!boite) return false;
      boite.focus();
      return document.activeElement === boite;
    })()`;
    const cochee = (libelle) => `(() => {
      const item = [...document.querySelectorAll(".team-choice-item")].find((e) => (e.querySelector("label")?.textContent ?? "").trim() === ${JSON.stringify(libelle)});
      return item?.querySelector("input[type=checkbox]")?.checked === true;
    })()`;
    const autre = carte.cases.map((c) => c.libelle).find((libelle) => libelle !== RETENU.titre);
    exiger(await page.evaluer(focaliser(autre)), `la case « ${autre} » ne prend pas le focus.`);
    // La barre d'espace se frappe par `taper(" ")` : `touche` n'envoie pas le caractère, et une case ne se coche pas sans lui.
    await page.taper(" ");
    await page.attendreQue(cochee(autre), { delaiMs: 5_000, libelle: `case « ${autre} » cochée au clavier` });
    await page.evaluer(focaliser(autre));
    await page.taper(" ");
    await page.attendreQue(`!${cochee(autre)}`, { delaiMs: 5_000, libelle: `case « ${autre} » décochée au clavier` });
    releve(ctx, `carte de choix tenue au clavier : « ${autre} » cochée puis décochée par la barre d'espace`);

    // [Continuer avec 1 spécialiste(s) (≈ … $)] : le bouton principal de la carte, actionné au clavier. Un bouton s'active
    // à l'Entrée ET à la barre d'espace (APG) ; le banc frappe l'espace, que `taper` envoie avec son caractère.
    await page.evaluer(`document.querySelector(".team-choice .team-card-actions button")?.focus()`);
    await page.taper(" ");
    const finieA = await attendreRun(api, runA, (vue) => vue.state === "terminee" || vue.state === "en-echec", "aiguillage terminé après confirmation", 90_000);
    exiger(finieA.state === "terminee", `lancement A en état « ${finieA.state} » : ${resume(finieA.steps.map((s) => `${s.stepId}=${s.state}`))}`);

    // 3. Spécialistes écartés : « non-choisi », état final SANS coût ; la synthèse aussi (moins de deux résultats choisis).
    const etatFinalA = (stepId) => finieA.steps.find((step) => step.stepId === stepId);
    exiger(etatFinalA(retenuA.id)?.state === "terminee", `le spécialiste retenu est en « ${etatFinalA(retenuA.id)?.state} ».`);
    for (const stepId of [...ecartesA, `${SYNTHESE}-aig`]) {
      const step = etatFinalA(stepId);
      exiger(step?.state === "non-choisi", `l'étape « ${stepId} » est en « ${step?.state} » au lieu de « non-choisi ».`);
      exiger(Number(step.cost ?? 0) === 0, `l'étape « ${stepId} », non choisie, porte un coût de ${step.cost} $.`);
    }
    const coutA = Number(finieA.cost ?? 0);
    exiger(Math.abs(coutA - (PROPOSE.cost + SPECIALISTE.cost)) < 1e-6, `coût du lancement A : ${coutA} $ au lieu de ${PROPOSE.cost + SPECIALISTE.cost} $.`);
    releve(ctx, `lancement A : ${coutA} $ — un aiguilleur et un spécialiste facturés, ${ecartesA.length + 1} étapes « Non choisi » sans coût`);

    // Le panneau de contexte dit « Non choisi » pour les spécialistes écartés (le Déroulé d'équipe est éprouvé par c5b-couts-archives).
    await ouvrirLaConversation(ctx, racineA);
    await page.attendreQue("document.querySelector('.team-result')", { delaiMs: 25_000, libelle: "carte de résultat de l'aiguillage" });
    const cartesDuFil = await page.evaluer(`[...document.querySelectorAll(".team-run .team-step-state")].map((e) => e.textContent.trim())`);
    releve(ctx, `états des étapes dans la carte d'exécution : ${resume(cartesDuFil)}`);

    // --- Lancement B : « aucun ne convient », sur une SECONDE copie (identifiants d'étape distincts) ---------------------
    const copieB = await equipeDeriveeC5(api, EXEMPLE, "auc");
    const blocB = copieB.flow.blocs.find((candidat) => candidat.type === "aiguillage");
    const etapesEcarteesB = [...blocB.specialistes.map((step) => step.id), blocB.synthese.id];
    await scripterEtape(ctx, blocB.aiguilleur.id, PROPOSE_AUCUN);
    const { runId: runB, rootId: racineB } = await lancerAvec(api, copieB.id, ALERTE_HORS_LISTE);
    lancements.push(runB);
    const attenteB = await attendreRun(api, runB, (vue) => vue.state === "attente-choix", "aiguillage en attente (aucun ne convient)");
    exiger((attenteB.pause.choix ?? []).every((option) => option.propose === false), "un spécialiste est présélectionné alors que l'aiguilleur n'en propose aucun.");

    // [Aucun ne convient] est un bouton de la carte de choix, actionné AU CLAVIER comme [Continuer] : c'est la personne qui
    // écarte la liste, jamais le cockpit. Rien n'est présélectionné, puisque l'aiguilleur n'a rien proposé.
    await ouvrirLaConversation(ctx, racineB);
    await page.attendreQue("document.querySelector('.team-choice')", { delaiMs: 25_000, libelle: "carte de choix (aucun ne convient)" });
    const carteB = await page.evaluer(carteDeChoix);
    exiger(carteB.cases.every((c) => !c.cochee), `cases cochées alors que l'aiguilleur ne propose rien : ${resume(carteB.cases)}`);
    const avantAucun = await repere(ctx);
    const focaliseAucun = await page.evaluer(`(() => {
      const bouton = [...document.querySelectorAll(".team-choice .team-card-actions button")].find((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.aucunConvient)});
      if (!bouton) return false;
      bouton.focus();
      return document.activeElement === bouton;
    })()`);
    exiger(focaliseAucun, `[${PHRASES.aucunConvient}] ne prend pas le focus : ${resume(carteB.boutons)}`);
    await page.taper(" ");
    const finieB = await attendreRun(api, runB, (vue) => vue.state === "terminee" || vue.state === "en-echec", "lancement « aucun ne convient » terminé", 60_000);
    exiger(finieB.state === "terminee", `lancement B en état « ${finieB.state} ».`);
    for (const stepId of etapesEcarteesB) {
      const step = finieB.steps.find((candidat) => candidat.stepId === stepId);
      exiger(step?.state === "non-choisi", `« ${stepId} » est en « ${step?.state} » au lieu de « non-choisi » après « aucun ».`);
    }
    const envoisApresAucun = envois(await requetesDepuis(ctx, avantAucun));
    exiger(envoisApresAucun.length === 0, `${envoisApresAucun.length} envoi(s) après « aucun ne convient » : rien ne doit partir.`);
    exiger(Math.abs(Number(finieB.cost ?? 0) - PROPOSE_AUCUN.cost) < 1e-6, `coût du lancement B : ${finieB.cost} $ au lieu du seul aiguilleur (${PROPOSE_AUCUN.cost} $).`);

    // 4. La carte porte la phrase du refus, nomme l'assistant de repli, et [Envoyer à cet assistant] PRÉREMPLIT sans envoyer.
    await ouvrirLaConversation(ctx, racineB);
    await page.attendreQue("document.querySelector('.team-aucun-actions button')", { delaiMs: 25_000, libelle: "[Envoyer à cet assistant]" });
    const resultatB = await page.evaluer(`(() => {
      const section = [...document.querySelectorAll(".team-result")].at(-1);
      return {
        texte: (section?.innerText ?? "").replace(/\\s+/g, " ").trim(),
        bouton: (section?.querySelector(".team-aucun-actions button")?.textContent ?? "").trim(),
      };
    })()`);
    releve(ctx, `résultat « aucun » : bouton « ${resultatB.bouton} »`);
    exiger(resultatB.texte.includes(PHRASES.aucun), `le résultat ne porte pas la phrase du refus : ${resume(resultatB.texte, 400)}`);
    exiger(resultatB.bouton === PHRASES.envoyer, `bouton du repli : « ${resultatB.bouton} ».`);

    const avantPreremplissage = await repere(ctx);
    await page.evaluer(`document.querySelector(".team-aucun-actions button").click()`);
    await page.attendreQue(
      "document.querySelector(\"textarea[aria-label='Message']\")?.value.length > 0",
      { delaiMs: 10_000, libelle: "composeur prérempli par [Envoyer à cet assistant]" },
    );
    const composeur = await page.evaluer(`(() => {
      const saisie = document.querySelector("textarea[aria-label='Message']");
      const choix = document.querySelector(".composer-assistant select");
      return { texte: (saisie?.value ?? "").trim(), assistant: choix?.value ?? null };
    })()`);
    releve(ctx, `composeur prérempli : assistant « ${composeur.assistant} », ${composeur.texte.length} caractères`);
    exiger(composeur.texte.includes(ALERTE_HORS_LISTE), `le composeur ne reprend pas la demande : ${resume(composeur.texte, 300)}`);
    exiger(composeur.assistant === blocB.repli, `le composeur a choisi « ${composeur.assistant} » au lieu de l'assistant de repli « ${blocB.repli} ».`);
    await attendre(800);
    const apresPreremplissage = await requetesDepuis(ctx, avantPreremplissage);
    exiger(
      envois(apresPreremplissage).length === 0,
      `${envois(apresPreremplissage).length} envoi(s) après [Envoyer à cet assistant] : le bouton PRÉREMPLIT, il n'envoie rien.`,
    );
    const vueB = await api.vue(runB);
    exiger(Math.abs(Number(vueB.cost ?? 0) - PROPOSE_AUCUN.cost) < 1e-6, `le coût du lancement a bougé après le préremplissage : ${vueB.cost} $.`);

    // La saisie est rendue à son état vide : les scénarios partagent la pile, et un composeur prérempli gênerait le suivant.
    await page.evaluer(`(() => {
      const saisie = document.querySelector("textarea[aria-label='Message']");
      if (!saisie) return;
      const poser = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      poser?.call(saisie, "");
      saisie.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
  }).finally(async () => {
    // Un lancement laissé en attente occupe une place parmi les équipes en cours : le scénario suivant serait refusé en
    // 409 « trop-d-equipes » pour une raison qui ne le regarde pas.
    if (apiDuScenario !== null) await arreterLesLancements(apiDuScenario, lancements);
  });

  ctx.expectNoConsoleErrors();
}
