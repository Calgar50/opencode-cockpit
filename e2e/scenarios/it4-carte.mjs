// Scénario e2e des équipes (itération 4, L41) : carte des assistants (spécification §5.2 l.887-892 ; fiches L39a et L39b).
//
// Ce que le scénario établit, dans la vraie pile :
//   1. `GET /api/agent-map` rend les arêtes de délégation lues dans le REGISTRE D'OPENCODE : `build` → `general` et
//      `build` → `explore`, toutes deux « demandée » (règle `task` à « ask » du profil servi), appliquées par opencode ;
//   2. la carte est en LECTURE SEULE : aucune requête d'écriture n'est partie vers opencode pendant sa lecture ;
//   3. dans la page, les vues « Centrée » et « Liste » se prennent AU CLAVIER SEUL (tabulation puis Entrée), le focus
//      n'est jamais volé, et la vue Liste écrit chaque lien en toutes lettres (U11 : la liste est la vérité) ;
//   4. une équipe installée est un nœud de la carte, avec une arête par étape.
// Aucune écriture, aucun appel d'IA : la carte ne fait que lire.
import { exiger, releve, resume } from "./it1-api-commun.mjs";
import { preparerPage } from "./it1-ui-commun.mjs";
import { enAvance, equipes, installerExemple, repere, requetesDepuis } from "./it4-commun.mjs";

/** Nombre maximal de tabulations avant d'abandonner la recherche d'un bouton : la page a peu d'éléments focalisables. */
const TABULATIONS = 40;

/**
 * Amène le focus, à la tabulation seule, sur le bouton de vue dont le texte est `libelle` ; rend le nombre de tabulations.
 * Le focus est relevé dans la page elle-même : c'est l'élément qui compte, pas son étiquette.
 */
async function tabulerJusqua(page, libelle) {
  // Le point de départ de la tabulation est l'élément qui a le focus : on le pose sur la recherche de la barre, juste
  // avant les deux boutons de vue dans l'ordre du document. Sans cela, une tabulation partie de la vue Liste parcourrait
  // d'abord tous les liens écrits de la liste.
  await page.evaluer('(() => { const r = document.querySelector(".ca-selecteur input"); if (r) r.focus(); else document.activeElement?.blur?.(); })()');
  const cible = `(() => {
    const bouton = [...document.querySelectorAll(".ca-vues-choix button")].find((b) => b.textContent.trim() === ${JSON.stringify(libelle)});
    return Boolean(bouton) && document.activeElement === bouton;
  })()`;
  for (let pas = 1; pas <= TABULATIONS; pas++) {
    await page.touche("Tab");
    if (await page.evaluer(cible)) return pas;
  }
  throw new Error(`le bouton « ${libelle} » n'est pas atteint au clavier seul en ${TABULATIONS} tabulations.`);
}

const presse = (page, libelle) =>
  page.evaluer(`(() => {
    const bouton = [...document.querySelectorAll(".ca-vues-choix button")].find((b) => b.textContent.trim() === ${JSON.stringify(libelle)});
    return bouton ? bouton.getAttribute("aria-pressed") : "absent";
  })()`);

export async function run(ctx) {
  const page = await preparerPage(ctx);

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    await installerExemple(api, "revue-sql");

    // 1 et 2. Arêtes de délégation du registre d'opencode, sans aucune écriture.
    const debut = await repere(ctx);
    const carte = await api.carte();
    const ecritures = (await requetesDepuis(ctx, debut)).filter((requete) => requete.method !== "GET");
    exiger(ecritures.length === 0, `la carte a écrit vers opencode : ${resume(ecritures.map((r) => `${r.method} ${r.pathname}`))}`);

    const delegations = carte.edges.filter((edge) => edge.kind === "delegue" && edge.from === "agent:build");
    const vers = (nom) => delegations.find((edge) => edge.to === `agent:${nom}`);
    for (const cible of ["general", "explore"]) {
      const arete = vers(cible);
      exiger(arete !== undefined, `aucune arête « build → ${cible} » : ${resume(delegations.map((e) => e.to))}`);
      exiger(arete.confirmation === "demandee", `« build → ${cible} » : confirmation « ${arete.confirmation} » au lieu de « demandee ».`);
      exiger(arete.appliquePar === "opencode", `« build → ${cible} » : appliquée par « ${arete.appliquePar} » au lieu d'opencode.`);
    }
    releve(ctx, `carte : build → general et build → explore, « demandée », appliquées par opencode (${carte.nodes.length} nœuds, ${carte.edges.length} arêtes)`);

    // 4. L'équipe installée est un nœud de la carte, avec une arête par étape.
    const equipe = carte.nodes.find((node) => node.kind === "equipe");
    exiger(equipe !== undefined, `aucun nœud d'équipe dans la carte : ${resume(carte.nodes.map((n) => n.kind))}`);
    // Une arête d'étape par étape, numérotées dans l'ordre de `planSteps`, ÉQUIPE PAR ÉQUIPE (la pile en porte plusieurs).
    const etapes = carte.edges.filter((edge) => edge.etape !== undefined);
    exiger(etapes.length > 0, "aucune arête d'étape dans la carte.");
    const parEquipe = new Map();
    for (const arete of etapes) parEquipe.set(arete.from, [...(parEquipe.get(arete.from) ?? []), arete.etape.numero]);
    for (const [noeud, numeros] of parEquipe) {
      exiger(
        numeros.every((numero, index) => numero === index + 1),
        `arêtes d'étape mal numérotées pour « ${noeud} » : ${resume(numeros)}`,
      );
    }
    exiger(parEquipe.has(equipe.id), `l'équipe « ${equipe.id} » n'a aucune arête d'étape : ${resume([...parEquipe.keys()])}`);

    // 3. Les deux vues au clavier seul, dans la page.
    await page.evaluer('location.hash = "#/assistants/carte"');
    await page.attendreQue("document.querySelector('.ca-vues-choix button')", { libelle: "sélecteur de vue de la carte" });
    exiger((await presse(page, "Centrée")) === "true", "la vue « Centrée » n'est pas le défaut visuel.");

    const pas = await tabulerJusqua(page, "Liste");
    await page.touche("Enter");
    await page.attendreQue("document.querySelector('.ca-vues.vue-liste')", { libelle: "vue Liste choisie au clavier" });
    exiger((await presse(page, "Liste")) === "true", "la vue « Liste » n'est pas marquée choisie après Entrée.");
    // Le focus reste sur le bouton actionné : aucune vue ne prend le focus à l'utilisateur (§5.5).
    const garde = await page.evaluer(`(() => {
      const bouton = [...document.querySelectorAll(".ca-vues-choix button")].find((b) => b.textContent.trim() === "Liste");
      return Boolean(bouton) && document.activeElement === bouton;
    })()`);
    exiger(garde === true, `le focus a été volé après le choix de la vue Liste (« ${await page.focus()} »).`);

    // La liste est la vérité : chaque lien y est écrit en toutes lettres.
    const liens = await page.evaluer(`(() => {
      const items = [...document.querySelectorAll(".ca-liste .ca-liens li")];
      return { lignes: items.length, sansPhrase: items.filter((li) => !li.querySelector(".ca-lien-phrase")?.textContent?.trim()).length };
    })()`);
    exiger(liens.lignes > 0, "la vue Liste ne montre aucun lien.");
    exiger(liens.sansPhrase === 0, `${liens.sansPhrase} lien(s) de la vue Liste sans phrase écrite.`);
    // Chaque lien s'écrit une fois : ni le mot du trait ni la mention « appliqué par » ne doit répéter l'autre.
    const doublons = await page.evaluer(`(() => {
      const lignes = [...document.querySelectorAll(".ca-liste .ca-liens li")];
      return lignes
        .map((li) => ({ mot: li.querySelector(".ca-lien-mot")?.textContent?.trim() ?? "", applique: li.querySelector(".ca-lien-applique")?.textContent?.trim() ?? "" }))
        .filter((ligne) => ligne.mot !== "" && ligne.mot === ligne.applique)
        .map((ligne) => ligne.mot);
    })()`);
    exiger(
      doublons.length === 0,
      `${doublons.length} lien(s) de la vue Liste écrivent deux fois la même mention (« ${doublons[0] ?? ""} » en « mot du trait » ET en « appliqué par ») : ` +
        "DÉFAUT PRODUIT (MOYEN) remis à l'intégrateur — carte-model.ts (L39b) donne `mot: motTrait(\"impose\")` et " +
        "`appliquePar: P.appliquePar.cockpit`, or agent-map-texts.ts (T4t) fait pointer `legende.impose` et " +
        "`appliquePar.cockpit` sur la MÊME phrase « imposé par le cockpit ». La vue Liste, qui est la vérité pour le " +
        "lecteur d'écran (U11), la lit donc deux fois de suite pour chaque arête d'étape.",
    );

    await tabulerJusqua(page, "Centrée");
    await page.touche("Enter");
    await page.attendreQue("document.querySelector('.ca-vues.vue-centree')", { libelle: "retour à la vue Centrée au clavier" });
    releve(ctx, `carte : vues Centrée (${pas} tabulations) et Liste prises au clavier seul, ${liens.lignes} lien(s) écrits en toutes lettres`);
  });

  ctx.expectNoConsoleErrors();
}
