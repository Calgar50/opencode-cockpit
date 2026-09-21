// Porte « git » — ce que le montage `:ro` d'un `.git` protège VRAIMENT sur cet hôte (D-2b-28, L15c ; risque 11 / C2-5).
//
// D-2b-28 protège les dépôts du dossier de travail en montant chaque `.git` en lecture seule, et le superviseur refuse de se
// déclarer prêt tant qu'un dépôt n'est pas protégé (`gitProtege`, étapes 5 et 7). La relecture 2bis-vague-2 a ajouté la sonde
// `aliasInscriptible` : un montage `:ro` protège UN chemin, pas le dossier ; sur un partage insensible à la casse, `.GIT`,
// `.Git` ou le nom court `GIT~1` désignent le même dossier sans traverser le montage.
//
// Cette porte ne suppose rien : elle mesure, depuis la salle, ce que chaque alias autorise, puis dit ce que le superviseur en
// a conclu. Elle est SANS OBJET quand le banc tourne en `--sans-git` (aucun dépôt à protéger).
//
// Ce qu'elle écrit dans le dépôt du banc : rien. Les dépôts sondés sont ceux, jetables, que le banc vient de créer.

/**
 * Sonde des alias, jouée en tant que `node` dans la salle. Même liste que `aliasDeNom` du superviseur : casses et nom court
 * 8.3. L'écriture d'essai va dans un dépôt jetable du banc, jamais dans un dépôt de l'utilisateur.
 */
const SONDE_ALIAS = `
const fs = require("node:fs");
const alias = [".git", ".GIT", ".Git", ".gIt", "GIT~1", "git~1"];
const out = {};
for (const projet of fs.readdirSync("/workspace")) {
  const entrees = {};
  for (const nom of alias) {
    const chemin = "/workspace/" + projet + "/" + nom;
    const e = {};
    try { e.existe = fs.lstatSync(chemin).isDirectory() ? "dossier" : "autre"; } catch (err) { e.existe = err.code; }
    if (e.existe === "dossier") {
      try { fs.accessSync(chemin, fs.constants.W_OK); e.inscriptible = true; } catch { e.inscriptible = false; }
      try { fs.writeFileSync(chemin + "/temoin-banc-alias", "x"); e.ecriture = "acceptee"; } catch (err) { e.ecriture = err.code; }
      try { fs.writeFileSync(chemin + "/hooks/temoin-banc-pre-commit", "x"); e.crochet = "acceptee"; } catch (err) { e.crochet = err.code; }
    }
    entrees[nom] = e;
  }
  out[projet] = entrees;
}
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: "git",
  titre: "Protection des dépôts : ce qu'un `.git` monté en lecture seule protège sur cet hôte",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    let amorce = null;
    try {
      amorce = JSON.parse(ctx.sortie("projets-amorce.json") ?? "null");
    } catch {
      amorce = null;
    }
    const proteges = Number(amorce?.gitProteges ?? 0);
    if (proteges === 0) {
      return { sansObjet: "aucun dépôt dans les projets préparés (banc dégradé --sans-git) : rien à protéger, rien à mesurer" };
    }

    // --- 1. Ce que la salle peut faire, alias par alias ---------------------------------------------------------------------
    let vue = null;
    const r = await ctx.exec("opencode-omo", ["node", "-e", SONDE_ALIAS], { delaiMs: 90_000 });
    try {
      vue = JSON.parse(String(r.sortie).trim());
    } catch {
      vue = null;
    }
    ctx.ecrireSortie("git-alias.json", `${JSON.stringify(vue, null, 2)}\n`);
    mesures.gitAlias = vue;
    if (!vue) {
      ajouter("la sonde des alias répond", false, `code ${r.code} — ${String(r.erreur ?? r.sortie).slice(0, 200)}`);
      return { points, mesures };
    }

    const projets = Object.entries(vue);
    const cheminExact = projets.filter(([, e]) => e[".git"]?.existe === "dossier" && e[".git"]?.ecriture !== "acceptee");
    ajouter(
      "le chemin exact `.git` est bien en lecture seule",
      cheminExact.length === projets.length,
      projets.map(([p, e]) => `${p}=${e[".git"]?.ecriture ?? e[".git"]?.existe}`).join(", "),
    );

    // Le cœur de la porte : un alias qui écrit est un dépôt de l'utilisateur ouvert à l'IA.
    const ouverts = [];
    for (const [projet, entrees] of projets) {
      for (const [nom, e] of Object.entries(entrees)) {
        if (nom !== ".git" && e.ecriture === "acceptee") ouverts.push(`${projet}/${nom}`);
      }
    }
    const crochets = [];
    for (const [projet, entrees] of projets) {
      for (const [nom, e] of Object.entries(entrees)) {
        if (nom !== ".git" && e.crochet === "acceptee") crochets.push(`${projet}/${nom}/hooks`);
      }
    }
    mesures.gitAliasOuverts = ouverts;
    mesures.gitCrochetsPosables = crochets;
    ajouter("aucun alias de casse ou nom court n'écrit dans le dépôt (risque 11 / C2-5)", ouverts.length === 0, ouverts.length === 0 ? "aucun" : `alias inscriptibles : ${ouverts.join(", ")}`);
    ajouter(
      "aucun crochet git ne peut être posé depuis la salle",
      crochets.length === 0,
      crochets.length === 0 ? "aucun" : `crochets posables (exécutés sur le poste au prochain commit) : ${crochets.join(", ")}`,
    );

    // --- 2. Ce que le superviseur en conclut ------------------------------------------------------------------------------
    // Le verdict fermé est le comportement ATTENDU : dépôt douteux → la salle ne démarre pas. Ce point reste vert quand le
    // superviseur ferme bien la porte, quelle que soit la cause du doute.
    const etat = (await ctx.etat()) ?? {};
    const nonProteges = etat.workspaceGit?.nonProteges ?? [];
    const projetsEtat = etat.projets ?? [];
    mesures.gitVerdict = { phase: etat.phase ?? null, nonProteges, projets: projetsEtat };
    const doute = ouverts.length > 0;
    ajouter(
      "le superviseur voit le même doute que la sonde",
      doute ? nonProteges.length > 0 : nonProteges.length === 0,
      `nonProteges = ${JSON.stringify(nonProteges)} ; projets = ${JSON.stringify(projetsEtat)}`,
    );
    ajouter(
      "un dépôt douteux ferme la salle (aucun opencode lancé)",
      doute ? etat.phase !== "opencode-lance" : etat.phase === "opencode-lance",
      `phase = ${etat.phase ?? "illisible"}`,
    );

    return { points, mesures };
  },
};
