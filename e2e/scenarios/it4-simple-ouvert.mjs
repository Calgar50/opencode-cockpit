// Scénario e2e des équipes (itération 4, L41) : l'ouverture des équipes en mode Simple tient en UNE ligne (décision U1).
//
// `EQUIPES_SIMPLE_OUVERTES` reste FAUSSE dans le dépôt : les équipes sont complètes en mode Avancé, et fermées en Simple
// jusqu'aux recettes du §7.11 n° 4. Le banc ne bascule la constante que dans sa COPIE JETABLE, pour cette exécution-là.
// Ce scénario s'adapte : si `GET /api/teams` annonce `ouvertesEnSimple: false` (l'exécution ordinaire), il le dit et ne
// joue rien ; s'il l'annonce vrai (l'exécution de la copie basculée), il éprouve l'ouverture entière :
//   1. les SIX routes fermées en Simple ne répondent plus 403 « equipes-simple-fermees » ;
//   2. le LANCEUR apparaît dans la saisie du chat ;
//   3. l'onglet ÉQUIPES montre la galerie, et non « Les équipes arrivent bientôt en mode Simple. » ;
//   4. l'ÉDITEUR guidé est accessible (écran 1 sur 4), et non remplacé par le même avis ;
//   5. l'AVIS DE DÉLÉGATION passe au texte complet, avec [Voir les équipes] ;
//   6. un exemple se lance de bout en bout EN SIMPLE et rend son résultat.
// Aucune de ces vérifications ne touche le dépôt : la constante y reste fausse.
import { attendre, delegation, exiger, nonJoue, oc, releve, resume } from "./it1-api-commun.mjs";
import { attendreIa, preparerPage } from "./it1-ui-commun.mjs";
import {
  attendreRun,
  corpsLancement,
  DOSSIER_EQUIPE,
  equipes,
  estimerEtLancer,
  ETAPES_AVIS,
  installerExemple,
  ouvrirLaConversation,
  scripterEtape,
} from "./it4-commun.mjs";

/** Phrase montrée tant que les équipes sont fermées en Simple : elle doit disparaître une fois la constante ouverte. */
const FERMEES = "Les équipes arrivent bientôt en mode Simple.";
/** Avis complet de délégation, ouvert seulement quand les équipes le sont (spéc. §3.14 l.437). */
const AVIS_COMPLET = "Pour faire travailler plusieurs assistants, lancez une équipe.";

const RUN_INCONNU = "00000000-0000-4000-8000-000000000000";

/** Un refus de mode fermé, quel que soit le code HTTP : c'est lui, et lui seul, qui doit avoir disparu. */
function exigerPasFermee(reponse, libelle) {
  const corps = (() => {
    try {
      return JSON.parse(reponse.corps);
    } catch {
      return {};
    }
  })();
  exiger(corps.error !== "equipes-simple-fermees", `${libelle} : encore fermée en Simple (${reponse.code} ${corps.error}).`);
}

export async function run(ctx) {
  const api = equipes(ctx);
  const liste = await api.liste();
  if (liste.ouvertesEnSimple !== true) {
    nonJoue(ctx, "ouverture des équipes en mode Simple", "EQUIPES_SIMPLE_OUVERTES est fausse dans le dépôt (U1) : le banc ne la bascule que dans sa copie jetable");
    ctx.expectNoConsoleErrors();
    return;
  }

  const reglages = await ctx.api.get("/api/settings");
  exiger(reglages?.ui?.mode === "simple", `ce scénario s'éprouve en mode Simple ; mode courant « ${reglages?.ui?.mode} ».`);
  const page = await preparerPage(ctx);

  // 1. Les six routes fermées ne le sont plus (le code exact dépend de l'état ; seul « equipes-simple-fermees » est interdit).
  const equipe = await installerExemple(api, "revue-sql");
  exigerPasFermee(await api.installerBrut("revue-sql"), "POST /api/teams/examples/:id/install");
  exigerPasFermee(await api.mettreAJourBrut("essai-simple", { titre: "Essai en Simple", description: "", flow: equipe.flow }), "PUT /api/teams/:id");
  exigerPasFermee(await api.estimerBrut("revue-sql"), "POST /api/teams/:id/estimate");
  exigerPasFermee(await api.lancerBrut("revue-sql", corpsLancement(null)), "POST /api/teams/:id/run");
  exigerPasFermee(await api.estimerRelanceBrut(RUN_INCONNU), "POST /api/team-runs/:id/estimate");
  exigerPasFermee(await api.relancerBrut(RUN_INCONNU, { estimateSha256: "0".repeat(64) }), "POST /api/team-runs/:id/relancer");
  releve(ctx, "mode Simple ouvert : les six routes fermées ne rendent plus « equipes-simple-fermees »");

  // 3 et 4. Onglet Équipes et éditeur guidé accessibles en Simple.
  await page.evaluer('location.hash = "#/assistants/equipes"');
  await page.attendreQue("document.querySelector('.tm-onglet')", { libelle: "onglet Équipes" });
  const onglet = await page.texte(".tm-onglet");
  exiger(!onglet.includes(FERMEES), `l'onglet Équipes montre encore l'avis de fermeture : ${resume(onglet, 300)}`);
  exiger(
    (await page.evaluer("Boolean(document.querySelector('.tm-equipes') || document.querySelector('.tm-galerie-ancre'))")) === true,
    "l'onglet Équipes ne montre ni équipe installée ni galerie.",
  );

  await page.evaluer('location.hash = "#/assistants/equipes/nouvelle"');
  await page.attendreQue("document.querySelector('.tm-ed')", { libelle: "éditeur guidé" });
  const editeur = await page.texte(".tm-ed");
  exiger(!editeur.includes(FERMEES), `l'éditeur guidé est encore fermé en Simple : ${resume(editeur, 300)}`);
  exiger(
    (await page.evaluer("Boolean(document.querySelector('.tm-ed-progression'))")) === true,
    "l'éditeur guidé n'affiche pas sa progression (« 1 / 4 ») : il n'est pas ouvert.",
  );

  // 2 et 5. Lanceur dans la saisie, et avis complet de délégation refusée en Simple.
  const client = oc(ctx, DOSSIER_EQUIPE);
  const ia = await attendreIa(ctx);
  const racine = await client.creerConversation("it4-simple-ouvert");
  await ctx.faux.scripter(racine.id, { tools: [delegation("Relire les journaux", "general", { text: "Rien d'anormal." })], followUp: { text: "Fait." } });
  await ouvrirLaConversation(ctx, racine.id);
  await page.attendreQue("document.querySelector('.team-launcher button')", { libelle: "lanceur d'équipe dans la saisie" });
  const envoi = await client.envoyer(racine.id, "Fais relire les journaux par un autre assistant.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await page.attendreQue("document.querySelector('.delegation-notice')", { delaiMs: 25_000, libelle: "avis de délégation du mode Simple" });
  const avis = await page.texte(".delegation-notice");
  exiger(avis.includes(AVIS_COMPLET), `l'avis de délégation garde le texte court : ${resume(avis, 300)}`);
  exiger(avis.includes("Voir les équipes"), `l'avis de délégation n'offre pas [Voir les équipes] : ${resume(avis, 300)}`);

  // 6. Un exemple de bout en bout, en mode Simple.
  for (const stepId of ETAPES_AVIS) {
    await scripterEtape(ctx, stepId, { text: `Avis « ${stepId} » rendu en mode Simple.`, cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: 5 });
  }
  const { runId, rootId } = await estimerEtLancer(api, "revue-sql");
  const finie = await attendreRun(api, runId, (vue) => vue.state === "terminee", "équipe lancée en mode Simple terminée");
  exiger(finie.steps.every((step) => step.state === "terminee"), `étapes : ${resume(finie.steps.map((s) => `${s.stepId}=${s.state}`))}`);
  await ouvrirLaConversation(ctx, rootId);
  await page.attendreQue("document.querySelector('.team-result')", { libelle: "carte de résultat en mode Simple" });
  await attendre(200);
  releve(ctx, "mode Simple ouvert : lanceur, onglet, éditeur, avis complet et lancement de bout en bout — l'ouverture tient à la seule constante");

  ctx.expectNoConsoleErrors();
}
