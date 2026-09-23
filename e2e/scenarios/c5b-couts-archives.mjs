// Scénario e2e de l'itération 5 (paquet L50b) : ce qu'une équipe LAISSE DERRIÈRE ELLE — coûts, archives, Déroulé d'équipe,
// Seconde lecture d'un résultat d'équipe et onglet Méthodes (spécification §5.4, §5.5, §5.6 ; conception C §9.6, §9.7,
// §17.3 n° 8 et 9, §17.4 ; plan d'exécution it5, fiches L44f, L46a, L46b ; D-5-10, D-5-11).
//
// Ce que le scénario établit, dans la vraie pile, sur le faux opencode :
//   1. DÉROULÉ D'ÉQUIPE d'une relecture faite en UN tour : « Prévu : jusqu'à 2 tours · Réel : 1 tour ». Le prévu vient du
//      déroulé lancé, le réel des tours vraiment faits — sans les deux, la phrase mentirait dans un sens ou dans l'autre ;
//   2. DÉROULÉ D'ÉQUIPE d'un aiguillage à UN choix : les spécialistes non retenus sont « Non choisi », dans le panneau de
//      contexte ET dans les Archives (le Déroulé d'équipe de la fiche, puis la ligne d'étape de la section « Équipes
//      lancées dans cette conversation »), et ils ne coûtent rien ;
//   3. COÛTS : la ligne « Par équipe » du mois, avec ses colonnes, et les deux lancements comptés ;
//   4. CSV des coûts : les colonnes `lancement_equipe` et `etape` à la FIN de l'en-tête, et au moins une ligne qui les
//      porte — sans quoi les coûts d'équipe ne se retrouvent pas hors du cockpit ;
//   5. ARCHIVES : la section « Équipes lancées dans cette conversation » et le filtre « Avec une équipe » ;
//   6. SECONDE LECTURE d'un RÉSULTAT D'ÉQUIPE : le bouton chiffré est proposé sous la carte de résultat, EN DERNIER — la
//      seconde lecture relit ce qui précède —, et son clic envoie UN message au Relecteur critique, dans la conversation de
//      l'équipe, avec la phrase EXACTE de la cible « équipe » (§4.3) ;
//   7. ONGLET MÉTHODES : les quatre onglets des assistants, et la bibliothèque des méthodes dans son panneau.
// En « --reel-hors-ligne », les étapes ne sont pas scriptables : le scénario le dit et ne joue rien.
import { attendre, attendreQue, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { LARGE, preparerPage } from "./it1-ui-commun.mjs";
import { attendreRun, enAvance, equipes, ouvrirLaConversation, scripterEtape } from "./it4-commun.mjs";
import { arreterLesLancements, equipeDeriveeC5, lancerAvec } from "./c5b-relecture.mjs";

/** Suffixe des équipes propres à ce scénario : les scénarios partagent UN faux, et un script « quand:etape= » vaut pour tous. */
const SUFFIXE = "c5b";
const RELECTEUR_CATALOGUE = "relecteur-critique";

/** Phrases attendues, écrites en clair (construction-texts.ts). */
const PHRASES = {
  ecartTours: "Prévu : jusqu'à 2 tours · Réel : 1 tour",
  nonChoisi: "Non choisi",
  parEquipe: "Par équipe",
  colonnes: ["Équipe", "Lancements", "Coût", "Moyenne par lancement", "Estimé en général"],
  archives: "Équipes lancées dans cette conversation",
  filtre: "Avec une équipe",
  onglets: ["Assistants", "Équipes", "Carte", "Méthodes"],
  secondeLecture: /^Seconde lecture \(≈ [^)]+ \$\)$/,
  relecteurAbsent: "Installez l'assistant « Relecteur critique » pour demander une seconde lecture.",
  /** Message de la cible « équipe » (construction-texts.ts `partout.secondeLecture.messageEquipe`), écrit en clair. */
  messageEquipe: (equipe) =>
    `Seconde lecture du résultat de l'équipe « ${equipe} ». Vérifie-le avec ta liste de contrôle. Relis les fichiers cités si tu y as accès. Ne change pas une conclusion sourcée sans fait nouveau.`,
};

/** Nom installé du Relecteur critique (l'assistant du catalogue), ou null. */
async function nomDuRelecteur(ctx) {
  const assistants = ((await ctx.api.get("/api/assistants"))?.assistants) ?? [];
  return assistants.find((assistant) => assistant.catalogId === RELECTEUR_CATALOGUE)?.name ?? null;
}

/**
 * Installe le Relecteur critique DEPUIS LE CATALOGUE, s'il n'y est pas déjà. Rend vrai quand l'assistant du catalogue est
 * bien là. Un refus PROPRE (catalogue d'IA indisponible, aucune IA du niveau demandé) n'est pas un défaut : c'est l'état
 * d'une pile sans accès au réseau, et le scénario éprouve alors l'autre moitié du contrat — la phrase et [Installer].
 */
async function installerLeRelecteur(ctx) {
  const installe = async () =>
    (((await ctx.api.get("/api/assistants"))?.assistants) ?? []).some((assistant) => assistant.catalogId === RELECTEUR_CATALOGUE);
  if (await installe()) return true;
  const pose = await ctx.api.brut("POST", `/api/assistants/catalogue/${RELECTEUR_CATALOGUE}/install`, {});
  if (pose.code === 200) return await installe();
  const propre = /catalogue-indisponible|ia-indisponible|sessions-busy/.test(pose.corps);
  exiger(propre, `installation du Relecteur critique refusée (${pose.code}) : ${resume(pose.corps, 300)}`);
  releve(ctx, `Repli du banc : le Relecteur critique n'est pas installable sur cette pile (${pose.code}) ; la Seconde lecture est éprouvée par sa phrase et [Installer].`);
  return false;
}

/** Colonnes ajoutées au CSV des coûts par la construction (ledger.ts, section `c5:csv`), à la FIN de l'en-tête. */
const COLONNES_CSV = ["lancement_equipe", "etape"];

const TOUR = (texte, cout) => ({ text: texte, cost: cout, tokens: { input: 600, output: 80, cache: { read: 0, write: 0 } }, stepMs: 5 });

/** Ouvre le panneau « Contexte » puis la vue Déroulé, et rend le texte du Déroulé d'équipe. */
async function derouleDEquipe(page) {
  const ouvert = "document.querySelector('.chat')?.classList.contains('aside-open') === true";
  if (!(await page.evaluer(ouvert))) {
    await page.evaluer(`document.querySelector('.chat-header button[aria-label="Afficher le contexte"]')?.click()`);
    await page.attendreQue(ouvert, { delaiMs: 10_000, libelle: "panneau « Contexte » ouvert" });
  }
  await page.attendreQue("document.querySelector('.team-deroule')", { delaiMs: 20_000, libelle: "Déroulé d'équipe" });
  return await page.evaluer(`(() => {
    const vue = document.querySelector(".team-deroule");
    return {
      texte: (vue.innerText ?? "").replace(/\\s+/g, " ").trim(),
      prevus: [...vue.querySelectorAll(".team-deroule-prevu")].map((e) => e.textContent.trim()).filter((t) => t !== ""),
      etats: [...vue.querySelectorAll(".deroule-state")].map((e) => e.textContent.trim()),
      lignes: [...vue.querySelectorAll(".deroule-row")].map((e) => (e.innerText ?? "").replace(/\\s+/g, " ").trim()),
    };
  })()`);
}

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "coûts, archives et Déroulé d'équipe", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }
  const page = await preparerPage(ctx, LARGE);

  const lancements = [];
  let apiDuScenario = null;
  /** Défauts du PRODUIT relevés en chemin : le scénario va au bout, puis tombe en les nommant tous. */
  const defauts = [];

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    apiDuScenario = api;

    // Le Relecteur critique est installé DEPUIS LE CATALOGUE, et avant toute équipe : le cockpit ne propose la Seconde
    // lecture qu'à l'assistant du catalogue (`catalogId`), et une équipe posée avant lui ferait écrire au banc un simple
    // fichier d'agent du même nom — l'installation choisirait alors un autre nom (« relecteur-critique-2 »).
    const relecteurInstalle = await installerLeRelecteur(ctx);

    // --- 1. Relecture faite en UN tour : « Prévu : jusqu'à 2 tours · Réel : 1 tour » ------------------------------------
    const relecture = await equipeDeriveeC5(api, "postmortem", SUFFIXE, () => ({ pauseAvantRelecture: false }));
    const blocRelecture = relecture.flow.blocs.find((bloc) => bloc.type === "relecture");
    exiger(blocRelecture.toursMax === 2, `toursMax de l'équipe dérivée : ${blocRelecture.toursMax}.`);
    await scripterEtape(ctx, blocRelecture.auteur.id, TOUR("# Compte rendu\n\nImpact chiffré, causes sourcées, actions datées.", 0.02));
    await scripterEtape(ctx, blocRelecture.relecteur.id, TOUR("Rien à redire : chaque fait est sourcé.\n\nVERDICT: RIEN À REPRENDRE", 0.01));
    const lancementR = await lancerAvec(api, relecture.id, "Rédige le compte rendu de l'incident de paiement.");
    lancements.push(lancementR.runId);
    const finieR = await attendreRun(api, lancementR.runId, (vue) => vue.state === "terminee" || vue.state === "en-echec", "relecture en un tour terminée", 90_000);
    exiger(finieR.state === "terminee", `relecture en état « ${finieR.state} » : ${resume(finieR.steps.map((s) => `${s.stepId}=${s.state}`))}`);
    const toursFaits = finieR.steps.filter((step) => step.stepId === blocRelecture.relecteur.id).length;
    exiger(toursFaits === 1, `${toursFaits} relecture(s) : le verdict « rien à reprendre » doit conclure au premier tour.`);
    exiger((finieR.blocs ?? []).some((bloc) => bloc.type === "relecture" && bloc.toursMax === 2), `le lancement ne porte pas le prévu : ${resume(finieR.blocs)}`);

    await ouvrirLaConversation(ctx, lancementR.rootId);
    const derouleR = await derouleDEquipe(page);
    releve(ctx, `Déroulé de la relecture : ${resume(derouleR.prevus)}`);
    exiger(
      derouleR.texte.includes(PHRASES.ecartTours),
      `le Déroulé n'écrit pas « ${PHRASES.ecartTours} » : ${resume(derouleR.texte, 400)}`,
    );

    // --- 6. Seconde lecture d'un RÉSULTAT D'ÉQUIPE ---------------------------------------------------------------------
    // La zone est là et EN DERNIER dans tous les cas : c'est le contrat de L44f. Le bouton CHIFFRÉ, lui, demande que le
    // Relecteur critique du catalogue soit installé — ce que la pile du banc ne permet pas toujours (catalogue d'IA).
    await page.attendreQue("document.querySelector('.team-result .seconde-lecture')", { delaiMs: 40_000, libelle: "Seconde lecture sous la carte de résultat" });
    {
      const bouton = await page.evaluer(`(() => {
        const carte = document.querySelector(".team-result");
        const zone = carte.querySelector(".seconde-lecture");
        const b = zone.querySelector("button");
        return {
          libelle: (b?.textContent ?? "").replace(/\\s+/g, " ").trim(),
          infobulle: b?.getAttribute("title") ?? "",
          phrase: (zone.querySelector(".seconde-lecture-phrase")?.textContent ?? "").trim(),
          dernier: carte.lastElementChild === zone,
        };
      })()`);
      releve(ctx, `Seconde lecture d'un résultat d'équipe : ${JSON.stringify(bouton)}`);
      exiger(bouton.dernier, "la Seconde lecture n'est pas en dernier sous la carte : elle relit ce qui précède.");
      if (relecteurInstalle) {
        exiger(PHRASES.secondeLecture.test(bouton.libelle), `libellé du bouton : « ${bouton.libelle} » (« Seconde lecture (≈ x $) » attendu).`);
        exiger(!/au moins/i.test(bouton.libelle) && !/au moins/i.test(bouton.infobulle), `« au moins » écrit dans la Seconde lecture (D-5-22) : « ${bouton.libelle} ».`);
        exiger(/Relecteur critique/.test(bouton.infobulle), `infobulle de la Seconde lecture : « ${bouton.infobulle} ».`);

        // Le clic, au clavier : UN envoi, dans la conversation de l'équipe, à l'agent du Relecteur, avec la phrase exacte de
        // la cible « équipe » — le nom de l'équipe est celui du lancement.
        const relecteur = await nomDuRelecteur(ctx);
        exiger(relecteur !== null, "Relecteur critique installé, mais introuvable dans GET /api/assistants.");
        const avantClic = (await ctx.opencodeRequests()).length;
        const focalise = await page.evaluer(`(() => {
          const b = document.querySelector(".team-result .seconde-lecture button");
          if (!b) return false;
          b.focus();
          return document.activeElement === b;
        })()`);
        exiger(focalise, "le bouton de la Seconde lecture ne prend pas le focus.");
        await page.taper(" ");
        const cheminAttendu = `/session/${lancementR.rootId}/prompt_async`;
        const envoisSeconde = await attendreQue(
          async () => {
            const recus = (await ctx.opencodeRequests()).slice(avantClic).filter((r) => r.method === "POST" && r.pathname === cheminAttendu);
            return recus.length > 0 ? recus : false;
          },
          { delaiMs: 20_000, pasMs: 250, libelle: "envoi de la Seconde lecture d'un résultat d'équipe reçu par opencode" },
        );
        await attendre(500);
        const tousLesEnvois = (await ctx.opencodeRequests()).slice(avantClic).filter((r) => r.method === "POST" && r.pathname === cheminAttendu);
        const corps = envoisSeconde[0].body ?? {};
        const texte = (corps.parts ?? []).map((part) => part.text ?? "").join("");
        releve(ctx, `Seconde lecture envoyée : agent « ${corps.agent} », ${tousLesEnvois.length} envoi(s)`);
        exiger(tousLesEnvois.length === 1, `${tousLesEnvois.length} envoi(s) pour UNE Seconde lecture.`);
        exiger(corps.agent === relecteur, `Seconde lecture envoyée à « ${corps.agent} » au lieu du Relecteur « ${relecteur} ».`);
        exiger(texte === PHRASES.messageEquipe(finieR.titre), `texte de la Seconde lecture d'un résultat d'équipe : ${resume(texte, 400)}`);
      } else {
        exiger(bouton.libelle === "Installer", `Relecteur absent : le bouton dit « ${bouton.libelle} » au lieu de [Installer].`);
        exiger(bouton.phrase === PHRASES.relecteurAbsent, `Relecteur absent : phrase « ${bouton.phrase} ».`);
        exiger(!PHRASES.secondeLecture.test(bouton.libelle), "un bouton chiffré est proposé sans Relecteur installé.");
      }
    }

    // --- 2. Aiguillage à UN choix : les spécialistes non retenus sont « Non choisi » -------------------------------------
    const aiguillage = await equipeDeriveeC5(api, "tri-alerte", SUFFIXE);
    const blocAiguillage = aiguillage.flow.blocs.find((bloc) => bloc.type === "aiguillage");
    const retenu = blocAiguillage.specialistes[1];
    await scripterEtape(ctx, blocAiguillage.aiguilleur.id, TOUR(`Le lien entre deux sites est en cause.\n\nCHOIX: ${retenu.titre}`, 0.004));
    await scripterEtape(ctx, retenu.id, TOUR("Regarder en lecture seule : temps de réponse, pertes, certificat.", 0.006));
    const lancementA = await lancerAvec(api, aiguillage.id, "Alerte : latence anormale sur la passerelle de paiement.");
    lancements.push(lancementA.runId);
    await attendreRun(api, lancementA.runId, (vue) => vue.state === "attente-choix", "aiguillage dérivé en attente de choix");
    const reponse = await api.continuerBrut(lancementA.runId, { choix: [retenu.id] });
    exiger(reponse.code === 200, `confirmation du choix refusée (${reponse.code}) : ${resume(reponse.corps, 300)}`);
    const finieA = await attendreRun(api, lancementA.runId, (vue) => vue.state === "terminee" || vue.state === "en-echec", "aiguillage dérivé terminé", 90_000);
    exiger(finieA.state === "terminee", `aiguillage en état « ${finieA.state} ».`);
    const ecartes = blocAiguillage.specialistes.filter((step) => step.id !== retenu.id);
    for (const step of ecartes) {
      const vu = finieA.steps.find((candidat) => candidat.stepId === step.id);
      exiger(vu?.state === "non-choisi", `« ${step.id} » est en « ${vu?.state} » au lieu de « non-choisi ».`);
      exiger(Number(vu.cost ?? 0) === 0, `« ${step.id} », non choisi, coûte ${vu.cost} $.`);
    }

    await ouvrirLaConversation(ctx, lancementA.rootId);
    const derouleA = await derouleDEquipe(page);
    const nonChoisisDuDeroule = derouleA.etats.filter((mot) => mot === PHRASES.nonChoisi).length;
    releve(ctx, `Déroulé de l'aiguillage : ${nonChoisisDuDeroule} ligne(s) « ${PHRASES.nonChoisi} » sur ${derouleA.lignes.length}`);
    exiger(
      nonChoisisDuDeroule >= ecartes.length,
      `${nonChoisisDuDeroule} « ${PHRASES.nonChoisi} » dans le panneau de contexte au lieu d'au moins ${ecartes.length} : ${resume(derouleA.etats)}`,
    );

    // --- 5 et 2 bis. Les Archives : le Déroulé d'équipe, la section des équipes, le filtre, et « Non choisi » -------------
    await page.evaluer(`location.hash = ${JSON.stringify(`#/archives/${lancementA.rootId}`)}`);
    // Le Déroulé d'équipe de la fiche d'Archives (TeamDeroule, placement « archives » : fiche L42c) dit « Non choisi ».
    await page.attendreQue("document.querySelector('.team-deroule .deroule-state')", { delaiMs: 30_000, libelle: "Déroulé d'équipe des Archives" });
    const derouleArchives = await page.evaluer(`[...document.querySelectorAll(".team-deroule .deroule-state")].map((e) => e.textContent.trim())`);
    const nonChoisisDeroule = derouleArchives.filter((mot) => mot === PHRASES.nonChoisi).length;
    releve(ctx, `Déroulé d'équipe des Archives : ${nonChoisisDeroule} ligne(s) « ${PHRASES.nonChoisi} » sur ${derouleArchives.length}`);
    exiger(
      nonChoisisDeroule >= ecartes.length,
      `${nonChoisisDeroule} « ${PHRASES.nonChoisi} » dans le Déroulé d'équipe des Archives au lieu d'au moins ${ecartes.length} : ${resume(derouleArchives)}`,
    );

    // La section « Équipes lancées dans cette conversation » (L46b) écrit chaque étape par la ligne fixe du §4.3 ; son état
    // doit y être dit par son MOT. Un écart ici n'arrête pas le scénario sur-le-champ : il est gardé, le reste est éprouvé,
    // et le scénario tombe à la fin en le nommant (un défaut du produit, pas du banc).
    await page.attendreQue("document.querySelector('.archive-teams')", { delaiMs: 30_000, libelle: "section « Équipes » des Archives" });
    const archives = await page.evaluer(`(() => {
      const carte = document.querySelector(".archive-teams");
      return {
        texte: (carte.innerText ?? "").replace(/\\s+/g, " ").trim(),
        etapes: [...carte.querySelectorAll(".team-step-line")].map((e) => e.textContent.replace(/\\s+/g, " ").trim()),
      };
    })()`);
    releve(ctx, `Archives : ${archives.etapes.length} ligne(s) d'étape`);
    exiger(archives.texte.includes(PHRASES.archives), `la section des Archives ne s'appelle pas « ${PHRASES.archives} » : ${resume(archives.texte, 300)}`);
    const lignesEcartees = archives.etapes.filter((ligne) => ecartes.some((step) => ligne.includes(`« ${step.titre} »`)));
    const nonChoisisArchives = lignesEcartees.filter((ligne) => ligne.includes(` · ${PHRASES.nonChoisi} · `)).length;
    releve(ctx, `section « ${PHRASES.archives} » : ${nonChoisisArchives} étape(s) écartée(s) dites « ${PHRASES.nonChoisi} » sur ${lignesEcartees.length}`);
    if (nonChoisisArchives < ecartes.length) {
      defauts.push(
        `DÉFAUT PRODUIT (Archives, section « ${PHRASES.archives} », L46b) : ${ecartes.length - nonChoisisArchives} étape(s) écartée(s) ` +
          `sur ${ecartes.length} ne disent pas « ${PHRASES.nonChoisi} » — ${resume(lignesEcartees, 500)}. Cause relevée : la table ETATS de ` +
          "app/web/pages/costs/TeamCosts.tsx (libelleEtat, EtatBadge) ne connaît ni « non-choisi » (5b, L42a) ni « non-lancee », " +
          "« en-file », « attente-accord » (it4) ; un code inconnu y est rendu tel quel. Le Déroulé d'équipe, lui, dit « Non choisi ».",
      );
    }

    await page.evaluer('location.hash = "#/archives"');
    await page.attendreQue("document.querySelector('.archives')", { delaiMs: 25_000, libelle: "liste des archives" });
    await page.attendreQue(
      `document.body.innerText.includes(${JSON.stringify(PHRASES.filtre)})`,
      { delaiMs: 15_000, libelle: `filtre « ${PHRASES.filtre} »` },
    );

    // --- 3. Coûts : la ligne « Par équipe » et ses colonnes -------------------------------------------------------------
    await page.evaluer('location.hash = "#/couts"');
    await page.attendreQue("document.querySelector('.team-table-wrap table')", { delaiMs: 30_000, libelle: "tableau « Par équipe »" });
    const couts = await page.evaluer(`(() => {
      const tableau = document.querySelector(".team-table-wrap table");
      return {
        legende: (tableau.querySelector("caption")?.textContent ?? "").trim(),
        colonnes: [...tableau.querySelectorAll("thead th")].map((e) => e.textContent.trim()),
        lignes: [...tableau.querySelectorAll("tbody tr")].map((tr) => (tr.innerText ?? "").replace(/\\s+/g, " ").trim()),
      };
    })()`);
    releve(ctx, `Coûts par équipe : ${couts.lignes.length} ligne(s), colonnes ${resume(couts.colonnes)}`);
    exiger(couts.legende === PHRASES.parEquipe, `légende du tableau : « ${couts.legende} ».`);
    for (const colonne of PHRASES.colonnes) exiger(couts.colonnes.includes(colonne), `colonne « ${colonne} » absente : ${resume(couts.colonnes)}`);
    exiger(couts.lignes.length >= 1, "aucune équipe dans les coûts du mois alors que deux lancements viennent d'aboutir.");
    exiger(
      couts.lignes.some((ligne) => ligne.includes(relecture.titre)) || couts.lignes.some((ligne) => ligne.includes(aiguillage.titre)),
      `les lancements de ce scénario ne sont pas comptés : ${resume(couts.lignes, 400)}`,
    );

    // --- 4. CSV des coûts : les deux colonnes de la construction, à la fin de l'en-tête ----------------------------------
    const mois = new Date().toISOString().slice(0, 7);
    const csv = await ctx.api.brut("GET", `/api/usage/export.csv?month=${mois}`);
    exiger(csv.code === 200, `export CSV refusé (${csv.code}).`);
    const entete = csv.corps.split("\r\n")[0].split(",");
    releve(ctx, `en-tête du CSV : ${resume(entete.slice(-4))}`);
    exiger(
      entete.slice(-COLONNES_CSV.length).join(",") === COLONNES_CSV.join(","),
      `les colonnes d'équipe ne terminent pas l'en-tête du CSV : ${resume(entete.slice(-4))}`,
    );
    const lignesCsv = csv.corps.split("\r\n").slice(1).filter((ligne) => ligne !== "");
    const avecEquipe = lignesCsv.filter((ligne) => ligne.includes(relecture.titre) || ligne.includes(aiguillage.titre));
    releve(ctx, `${avecEquipe.length} ligne(s) du CSV portent un lancement d'équipe sur ${lignesCsv.length}`);
    exiger(avecEquipe.length >= 1, "aucune ligne du CSV ne nomme un lancement d'équipe : les coûts d'équipe ne se retrouvent pas hors du cockpit.");

    // --- 7. Onglet Méthodes ---------------------------------------------------------------------------------------------
    await page.evaluer('location.hash = "#/assistants/methodes"');
    await page.attendreQue("document.querySelector('.ast-tabs [role=tab][aria-selected=true]')", { delaiMs: 25_000, libelle: "onglets des assistants" });
    // La bibliothèque arrive après l'onglet (lecture de GET /api/methods) : elle est attendue, pas lue au premier rendu.
    await page.attendreQue("document.querySelector('.ast-tabpanel .met-library')", { delaiMs: 25_000, libelle: "bibliothèque des méthodes dans l'onglet" });
    const onglets = await page.evaluer(`(() => {
      const liste = document.querySelector(".ast-tabs");
      return {
        noms: [...liste.querySelectorAll("[role=tab]")].map((b) => b.textContent.trim()),
        actif: (liste.querySelector("[role=tab][aria-selected=true]")?.textContent ?? "").trim(),
        panneau: Boolean(document.querySelector(".ast-tabpanel .met-library")),
      };
    })()`);
    releve(ctx, `onglets des assistants : ${resume(onglets.noms)}, actif « ${onglets.actif} »`);
    exiger(onglets.noms.join("|") === PHRASES.onglets.join("|"), `onglets : ${resume(onglets.noms)} (${resume(PHRASES.onglets)} attendus).`);
    exiger(onglets.actif === "Méthodes", `onglet actif « ${onglets.actif} » au lieu de « Méthodes ».`);
    exiger(onglets.panneau, "le panneau de l'onglet Méthodes ne porte pas la bibliothèque des méthodes.");
    await attendre(100);

    // Tout le reste est éprouvé : les défauts du produit relevés en chemin font maintenant tomber le scénario.
    exiger(defauts.length === 0, defauts.join(" | "));
  }).finally(async () => {
    // Un lancement laissé en attente occupe une place parmi les équipes en cours : le scénario suivant serait refusé en
    // 409 « trop-d-equipes » pour une raison qui ne le regarde pas.
    if (apiDuScenario !== null) await arreterLesLancements(apiDuScenario, lancements);
  });

  ctx.expectNoConsoleErrors();
}
