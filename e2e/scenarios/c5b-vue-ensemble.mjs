// Scénario e2e de l'itération 5 (paquet L50b) : la VUE D'ENSEMBLE de la carte des assistants (spécification §5.2 l.890,
// §5.5, §5.6 ; conception C §7.4, §9.9, §17.3 n° 6 ; plan d'exécution it5, fiche L48).
//
// Ce que le scénario établit, dans la vraie pile :
//   1. la vue n'existe qu'en mode AVANCÉ : en Simple, la bascule ne l'offre pas ;
//   2. les PUCES de filtre : une par groupe, le même libellé pour les deux (§4.3) ; une puce éteinte retire son groupe et
//      ses nœuds, rallumée elle les rend — et une puce éteinte ne se contente pas d'estomper, elle RETIRE ;
//   3. le FOCUS : un nœud est un vrai bouton ; Entrée le met (`aria-pressed`), Échap le retire ; le focus ne cache rien ;
//   4. l'ESTOMPAGE SE LIT : chaque nœud et chaque lien estompé porte « (hors sujet) » pour le lecteur d'écran — ce qui
//      n'était dit que par l'opacité est aussi écrit (§5.5) ;
//   5. les connecteurs SVG sont DÉCORATIFS (`aria-hidden`, non focalisables) et chaque lien est REPRIS EN TEXTE sous les
//      colonnes : la vue se lit sans le dessin.
// La carte est en LECTURE SEULE : ce scénario ne modifie rien, ni assistant, ni équipe, ni réglage durable.
import { attendre, exiger, releve, resume } from "./it1-api-commun.mjs";
import { attendreModeAffiche, LARGE, preparerPage } from "./it1-ui-commun.mjs";
import { enAvance, equipes } from "./it4-commun.mjs";

/** Libellés des huit groupes (construction-texts.ts `avance.vueEnsemble`), écrits en clair : un groupe, une puce, un libellé. */
const GROUPES = ["Vous", "Raccourcis", "Équipes", "Assistants", "Intégrés", "Agents du Studio", "Sous-agents", "Fiches"];

/** Phrases attendues, écrites en clair. */
const PHRASES = {
  titre: "Vue d'ensemble",
  aide: "Survolez ou sélectionnez un élément pour n'afficher que ses liens.",
  filtres: "Afficher",
  liens: "Liens",
  horsSujet: "(hors sujet)",
};

/** État de la vue : puces, groupes, nœuds, liens, et ce qui est estompé — tout lu dans l'arbre rendu. */
const ETAT = `(() => {
  const vue = document.querySelector(".ov-ensemble");
  if (!vue) return null;
  const lire = (e) => (e.innerText ?? e.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    etiquette: vue.getAttribute("aria-label"),
    aide: (vue.querySelector(".ov-aide")?.textContent ?? "").trim(),
    filtresEtiquette: vue.querySelector(".ov-filtres")?.getAttribute("aria-label"),
    puces: [...vue.querySelectorAll(".ov-puce")].map((b) => ({ libelle: b.textContent.trim(), allumee: b.getAttribute("aria-pressed") === "true" })),
    groupes: [...vue.querySelectorAll(".ov-groupe")].map((g) => ({ titre: (g.querySelector(".ov-groupe-titre")?.textContent ?? "").trim(), noeuds: g.querySelectorAll(".ov-noeud").length })),
    noeuds: [...vue.querySelectorAll(".ov-noeud")].map((b) => ({
      nom: (b.querySelector(".ov-noeud-nom")?.textContent ?? "").trim(),
      choisi: b.getAttribute("aria-pressed") === "true",
      estompe: b.classList.contains("estompe"),
      horsSujet: lire(b).includes(${JSON.stringify(PHRASES.horsSujet)}),
    })),
    liens: [...vue.querySelectorAll(".ov-lien")].map((li) => ({
      texte: lire(li),
      estompe: li.classList.contains("estompe"),
      horsSujet: lire(li).includes(${JSON.stringify(PHRASES.horsSujet)}),
    })),
    liensEtiquette: vue.querySelector(".ov-liens")?.getAttribute("aria-label"),
    connecteurs: [...vue.querySelectorAll("svg.ov-connecteur")].map((s) => ({
      cache: s.getAttribute("aria-hidden") === "true",
      focalisable: s.getAttribute("focusable") !== "false",
    })),
  };
})()`;

/** Ouvre l'onglet Carte puis la vue d'ensemble, et attend qu'elle soit dessinée. */
async function ouvrirLaVue(page) {
  await page.evaluer('location.hash = "#/assistants/carte"');
  await page.attendreQue("document.querySelector('.ca-vues-choix')", { delaiMs: 25_000, libelle: "bascule des vues de la carte" });
  await page.attendreQue(
    `[...document.querySelectorAll(".ca-vues-choix button")].some((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.titre)})`,
    { delaiMs: 15_000, libelle: `bouton « ${PHRASES.titre} »` },
  );
  await page.evaluer(`[...document.querySelectorAll(".ca-vues-choix button")].find((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.titre)}).click()`);
  await page.attendreQue("document.querySelector('.ov-ensemble .ov-noeud')", { delaiMs: 15_000, libelle: "vue d'ensemble dessinée" });
}

export async function run(ctx) {
  const page = await preparerPage(ctx, LARGE);
  const api = equipes(ctx);
  const carte = await api.carte();
  exiger(Array.isArray(carte?.nodes) && carte.nodes.length > 0, `GET /api/agent-map sans nœud : ${resume(carte)}`);

  // 1. En mode Simple (le mode par défaut), la bascule n'offre pas la vue d'ensemble.
  await attendreModeAffiche(page, "simple");
  await page.evaluer('location.hash = "#/assistants/carte"');
  await page.attendreQue("document.querySelector('.ca-vues-choix')", { delaiMs: 25_000, libelle: "bascule des vues de la carte (Simple)" });
  const enSimple = await page.evaluer(`[...document.querySelectorAll(".ca-vues-choix button")].map((b) => b.textContent.trim())`);
  releve(ctx, `bascule des vues en mode Simple : ${resume(enSimple)}`);
  exiger(!enSimple.includes(PHRASES.titre), `la vue d'ensemble est offerte en mode Simple : ${resume(enSimple)}`);
  exiger((await page.evaluer("Boolean(document.querySelector('.ov-ensemble'))")) === false, "la vue d'ensemble est montée en mode Simple.");

  await enAvance(ctx, async () => {
    await attendreModeAffiche(page, "avance");
    await ouvrirLaVue(page);

    const depart = await page.evaluer(ETAT);
    releve(ctx, `vue d'ensemble : ${depart.puces.length} puce(s), ${depart.groupes.length} groupe(s), ${depart.noeuds.length} nœud(s), ${depart.liens.length} lien(s)`);
    exiger(depart.etiquette === PHRASES.titre, `nom de la vue : « ${depart.etiquette} ».`);
    exiger(depart.aide === PHRASES.aide, `phrase d'aide : « ${depart.aide} ».`);
    exiger(depart.filtresEtiquette === PHRASES.filtres, `nom du groupe de puces : « ${depart.filtresEtiquette} ».`);
    exiger(depart.liensEtiquette === PHRASES.liens, `nom de la reprise en texte des liens : « ${depart.liensEtiquette} ».`);

    // 2. Une puce par groupe, le MÊME libellé pour les deux, et les huit libellés de la spécification.
    const libellesDesPuces = depart.puces.map((puce) => puce.libelle);
    exiger(
      libellesDesPuces.length === GROUPES.length && GROUPES.every((nom) => libellesDesPuces.includes(nom)),
      `puces de filtre : ${resume(libellesDesPuces)} (les huit libellés de §4.3 attendus).`,
    );
    exiger(depart.puces.every((puce) => puce.allumee), `toutes les puces ne sont pas allumées au départ : ${resume(depart.puces)}`);
    for (const groupe of depart.groupes) {
      exiger(GROUPES.includes(groupe.titre), `titre de groupe inattendu : « ${groupe.titre} ».`);
    }

    // Une puce éteinte RETIRE son groupe (elle ne l'estompe pas), et rallumée elle le rend.
    const visible = depart.groupes.find((groupe) => groupe.noeuds > 0);
    exiger(visible !== undefined, "aucun groupe n'a de nœud : rien à filtrer.");
    const cliquerLaPuce = (libelle) =>
      page.evaluer(`[...document.querySelectorAll(".ov-puce")].find((b) => b.textContent.trim() === ${JSON.stringify(libelle)}).click()`);
    await cliquerLaPuce(visible.titre);
    await page.attendreQue(
      `[...document.querySelectorAll(".ov-groupe-titre")].every((t) => t.textContent.trim() !== ${JSON.stringify(visible.titre)})`,
      { libelle: `groupe « ${visible.titre} » retiré par sa puce` },
    );
    const eteinte = await page.evaluer(ETAT);
    releve(ctx, `puce « ${visible.titre} » éteinte : ${eteinte.noeuds.length} nœud(s) au lieu de ${depart.noeuds.length}`);
    exiger(
      eteinte.noeuds.length === depart.noeuds.length - visible.noeuds,
      `${eteinte.noeuds.length} nœud(s) après extinction de « ${visible.titre} » au lieu de ${depart.noeuds.length - visible.noeuds}.`,
    );
    exiger(
      eteinte.puces.find((puce) => puce.libelle === visible.titre)?.allumee === false,
      `la puce « ${visible.titre} » reste allumée après son clic.`,
    );
    await cliquerLaPuce(visible.titre);
    await page.attendreQue(
      `[...document.querySelectorAll(".ov-groupe-titre")].some((t) => t.textContent.trim() === ${JSON.stringify(visible.titre)})`,
      { libelle: `groupe « ${visible.titre} » rendu par sa puce` },
    );
    const rallumee = await page.evaluer(ETAT);
    exiger(rallumee.noeuds.length === depart.noeuds.length, `${rallumee.noeuds.length} nœud(s) après rallumage au lieu de ${depart.noeuds.length}.`);
    exiger(
      rallumee.groupes.map((groupe) => groupe.titre).join("|") === depart.groupes.map((groupe) => groupe.titre).join("|"),
      `l'ordre des groupes a changé après un aller-retour de puce : ${resume(rallumee.groupes.map((g) => g.titre))}`,
    );

    // 3. Le focus : un vrai bouton, Entrée le met, Échap le retire.
    //    La vue s'ouvre avec un focus de DÉPART : l'élément montré par la carte (`elementMontre`, « Vous » par défaut). Entrée
    //    sur ce nœud-là le RETIRERAIT (le bouton bascule) : le nœud éprouvé est donc un nœud qui n'a pas encore le focus, et
    //    Entrée doit le lui donner — sans repli sur une autre touche.
    const depuis = rallumee.noeuds.find((noeud) => noeud.choisi)?.nom ?? null;
    const candidat = rallumee.noeuds.find((noeud) => !noeud.choisi);
    exiger(candidat !== undefined, `tous les nœuds ont déjà le focus : ${resume(rallumee.noeuds.slice(0, 5))}`);
    const nom = candidat.nom;
    const selecteurNoeud = `[...document.querySelectorAll(".ov-noeud")].find((b) => (b.querySelector(".ov-noeud-nom")?.textContent ?? "").trim() === ${JSON.stringify(nom)})`;
    const focalise = await page.evaluer(`(() => { const b = ${selecteurNoeud}; if (!b) return false; b.focus(); return document.activeElement === b && b.tagName === "BUTTON"; })()`);
    exiger(focalise, `le nœud « ${nom} » n'est pas un bouton focalisable.`);
    const pose = `${selecteurNoeud}?.getAttribute("aria-pressed") === "true"`;
    await page.touche("Enter");
    await page.attendreQue(pose, { delaiMs: 5_000, libelle: `focus posé sur « ${nom} » par Entrée` });
    releve(ctx, `focus posé sur « ${nom} » par Entrée (focus de départ : ${depuis === null ? "aucun" : `« ${depuis} »`})`);
    const unSeul = await page.evaluer(`document.querySelectorAll('.ov-noeud[aria-pressed="true"]').length`);
    exiger(unSeul === 1, `${unSeul} nœud(s) portent le focus après Entrée : un seul est attendu.`);

    // 4. L'estompage SE LIT : « (hors sujet) » sur chaque nœud et chaque lien estompé, et rien n'est retiré de l'arbre.
    const avecFocus = await page.evaluer(ETAT);
    const estompes = avecFocus.noeuds.filter((noeud) => noeud.estompe);
    const liensEstompes = avecFocus.liens.filter((lien) => lien.estompe);
    releve(ctx, `focus sur « ${nom} » : ${estompes.length} nœud(s) et ${liensEstompes.length} lien(s) estompés sur ${avecFocus.noeuds.length} et ${avecFocus.liens.length}`);
    exiger(estompes.length > 0, `le focus n'estompe rien : ${resume(avecFocus.noeuds.slice(0, 5))}`);
    exiger(avecFocus.noeuds.length === rallumee.noeuds.length, "le focus a retiré des nœuds : seules les puces en retirent.");
    for (const noeud of estompes) exiger(noeud.horsSujet, `le nœud estompé « ${noeud.nom} » ne dit pas « ${PHRASES.horsSujet} ».`);
    for (const lien of liensEstompes) exiger(lien.horsSujet, `un lien estompé ne dit pas « ${PHRASES.horsSujet} » : ${resume(lien.texte, 120)}`);
    for (const noeud of avecFocus.noeuds.filter((candidat) => !candidat.estompe)) {
      exiger(!noeud.horsSujet, `le nœud « ${noeud.nom} », qui n'est pas estompé, dit « ${PHRASES.horsSujet} ».`);
    }

    await page.touche("Escape");
    await page.attendreQue(`document.querySelectorAll(".ov-noeud.estompe").length === 0`, { delaiMs: 8_000, libelle: "focus retiré par Échap" });
    const apresEchap = await page.evaluer(ETAT);
    exiger(apresEchap.noeuds.every((noeud) => !noeud.horsSujet), `« ${PHRASES.horsSujet} » reste lu après Échap.`);
    exiger(apresEchap.noeuds.every((noeud) => !noeud.choisi), `un nœud garde le focus après Échap : ${resume(apresEchap.noeuds.filter((n) => n.choisi))}`);
    exiger(apresEchap.liens.every((lien) => !lien.horsSujet), "un lien reste « (hors sujet) » après Échap.");

    // 5. Connecteurs décoratifs, liens repris en toutes lettres.
    exiger(apresEchap.connecteurs.every((svg) => svg.cache && !svg.focalisable), `un connecteur SVG est lu ou focalisable : ${resume(apresEchap.connecteurs)}`);
    exiger(apresEchap.liens.length > 0, "aucun lien repris en texte sous les colonnes : la vue ne se lit pas sans le dessin.");
    for (const lien of apresEchap.liens.slice(0, 5)) exiger(lien.texte.length > 0, "un lien repris en texte est vide.");
    releve(ctx, `${apresEchap.connecteurs.length} connecteur(s) décoratifs, ${apresEchap.liens.length} lien(s) repris en toutes lettres`);
    await attendre(100);
  });

  await attendreModeAffiche(page, "simple");
  ctx.expectNoConsoleErrors();
}
