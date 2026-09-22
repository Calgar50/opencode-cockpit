// Porte G2 — chargement de l'extension (spéc. §7.10 l.1223 ; plan fiche L21 ; constats-salle-V1 §2.1 et §5 ; MO-3 point 8).
//
// C'est la porte du « premier démarrage réel » : l'étape 1 bis du superviseur a posé la configuration du HOME dans le volume
// `omo-config`, et il faut prouver que la configuration d'INSTANCE est appliquée et que rien dans ces montages en lecture seule
// n'arrête l'extension.
//
// La couche UTILISATEUR (`~/.omo/omo.jsonc`), elle, n'est pas appliquée par la 4.19.4 : mesuré ici même deux fois (rapport L21
// §4.2, puis la remesure de la répétition générale de la 2 bis, `CLAUDE_CONFIG_DIR` posé, qui infirme l'hypothèse du §4.3
// point 3). Le produit ne s'appuie plus dessus — les coupures qui comptent sont dans la configuration d'instance et dans le
// filet du cockpit — et cette porte le RELÈVE désormais comme mesure, sans en faire un verdict : elle ne juge que ce dont le
// produit dépend.
//
// Ce qui est vérifié :
// 1. les CINQ dossiers du HOME ne sont pas inscriptibles par `node`, et chacun porte `omo.jsonc` et `.gitignore` ;
// 2. la configuration d'instance est appliquée : `GET /config` rend ses greffons, son fournisseur et son IA, et `GET /agent`
//    rend les agents de l'extension (ils n'existeraient pas si le greffon ne s'était pas chargé) ;
// 3. aucune écriture refusée ne l'arrête : ni `~/.omo` (journal et sauvegardes de migration, `_migrations`), ni
//    `~/.config/opencode` (`tui.json`) ; les traces EROFS/EACCES sont relevées et la salle sert quand même ;
// 4. `ps` toutes les 500 ms pendant le démarrage : ni `npm`, ni `arborist`, ni `bun install` ;
// 5. F-aa : le greffon déclaré est bien en place (la configuration le nomme, l'instance l'a chargé) ;
// 6. migrations F-t sans effet : aucun `.sisyphus` ni `.omo` créé dans les projets par le chargement ;
// 7. `/auth-src` ne contient QUE `auth.json`, et aucun fichier d'`oc-data` (instance principale) n'y est lisible ;
// 8. MO-3 point 8 : les montages imbriqués tiennent (le HOME en tmpfs, cinq volumes en lecture seule dessous).
import { cleAgent } from "./g12-agents.mjs";

/** Relevé dans le conteneur : droits des cinq dossiers du HOME, contenu, écriture tentée. Rend un JSON. */
const SONDE_HOME = `
const fs = require("node:fs");
const path = require("node:path");
const dossiers = ["/home/node/.config/opencode", "/home/node/.opencode", "/home/node/.omo", "/home/node/.claude", "/home/node/.agents"];
const out = { dossiers: {}, authSrc: null, workspace: {}, donnees: null };
for (const d of dossiers) {
  const entree = { existe: false };
  try {
    const st = fs.statSync(d);
    entree.existe = true;
    entree.dossier = st.isDirectory();
    entree.uid = st.uid;
    entree.mode = (st.mode & 0o777).toString(8);
    entree.contenu = fs.readdirSync(d).sort();
    try { fs.accessSync(d, fs.constants.W_OK); entree.inscriptible = true; } catch (e) { entree.inscriptible = false; entree.refus = e.code; }
    try { fs.writeFileSync(path.join(d, "temoin-banc.txt"), "x"); entree.ecritureReelle = "acceptee"; } catch (e) { entree.ecritureReelle = e.code; }
  } catch (e) { entree.erreur = e.code; }
  out.dossiers[d] = entree;
}
try { out.authSrc = fs.readdirSync("/auth-src").sort(); } catch (e) { out.authSrc = { erreur: e.code }; }
try {
  out.donnees = fs.readdirSync("/home/node/.local/share/opencode").sort();
} catch (e) { out.donnees = { erreur: e.code }; }
for (const p of ["/workspace/projet-ouvert", "/workspace/projet-temoin"]) {
  try { out.workspace[p] = fs.readdirSync(p).sort(); } catch (e) { out.workspace[p] = { erreur: e.code }; }
}
out.montages = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\\n").filter((l) => /home\\/node|auth-src|omo-state|control|omo-config/.test(l)).length;
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: "g2",
  titre: "Chargement de l'extension : configuration d'instance appliquée, rien d'installé, rien qui bloque",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    const sonde = await ctx.exec("opencode-omo", ["node", "-e", SONDE_HOME], { delaiMs: 60_000 });
    let vue = null;
    try {
      vue = JSON.parse(String(sonde.sortie).trim());
    } catch {
      vue = null;
    }
    ctx.ecrireSortie("g2-home.json", `${JSON.stringify(vue ?? { brut: String(sonde.sortie).slice(0, 2000) }, null, 2)}\n`);
    if (!vue) {
      ajouter("sonde du HOME lisible", false, String(sonde.erreur || sonde.sortie).slice(0, 300));
      return { points, mesures };
    }

    // --- 1. Les cinq dossiers du HOME --------------------------------------------------------------------------------------
    const entrees = Object.entries(vue.dossiers);
    const fermes = entrees.filter(([, d]) => d.existe && d.inscriptible === false && d.ecritureReelle !== "acceptee");
    ajouter("les cinq dossiers du HOME ne sont pas inscriptibles par node", fermes.length === 5, `${fermes.length}/5 ; refus : ${entrees.map(([, d]) => d.ecritureReelle).join(", ")}`);
    const garnis = entrees.filter(([, d]) => Array.isArray(d.contenu) && d.contenu.includes("omo.jsonc") && d.contenu.includes(".gitignore"));
    ajouter("chacun porte omo.jsonc et .gitignore (étape 1 bis)", garnis.length === 5, `${garnis.length}/5 : ${entrees.map(([c, d]) => `${c.split("/").pop()}=${(d.contenu ?? []).join("|")}`).join(" ; ")}`);
    const aRoot = entrees.filter(([, d]) => d.uid === 0);
    ajouter("les cinq appartiennent à root", aRoot.length === 5, `${aRoot.length}/5`);
    ajouter("montages imbriqués en place (MO-3 point 8)", vue.montages >= 6, `${vue.montages} montages relevés sous le HOME et les volumes`);

    // --- 2. L'extension a lu la référence -----------------------------------------------------------------------------------
    const dossier = "/workspace/projet-ouvert";
    const config = await ctx.client.get(`/config?directory=${encodeURIComponent(dossier)}`);
    const agents = await ctx.client.get(`/agent?directory=${encodeURIComponent(dossier)}`);
    const affiches = Array.isArray(agents.json) ? agents.json.map((a) => a.name ?? a.id).filter(Boolean) : [];
    // `GET /agent` rend des noms d'affichage (« Sisyphus - ultraworker ») ; la clé de configuration est ce qui précède le
    // tiret entouré d'espaces (voir `cleAgent`, porte G12).
    const nomsAgents = [...new Set(affiches.map(cleAgent))];
    ctx.ecrireSortie("g2-agents.json", `${JSON.stringify({ code: agents.code, affiches: affiches.sort(), noms: nomsAgents.sort() }, null, 2)}\n`);
    ctx.ecrireSortie(
      "g2-config.json",
      `${JSON.stringify({ code: config.code, plugin: config.json?.plugin, provider: Object.keys(config.json?.provider ?? {}), model: config.json?.model, snapshot: config.json?.snapshot }, null, 2)}\n`,
    );
    ajouter("GET /config répond", config.code === 200, `code ${config.code}`);
    ajouter("GET /agent rend des agents", agents.code === 200 && nomsAgents.length > 0, `${nomsAgents.length} agents : ${nomsAgents.slice(0, 16).join(", ")}`);
    // Les agents propres à l'extension (aucun opencode nu ne les a) : la preuve que le greffon déclaré par la configuration
    // d'instance s'est bien chargé. Ils ne prouvent RIEN sur ~/.omo/omo.jsonc : l'extension les crée sans cette couche.
    const propres = ["sisyphus", "hephaestus", "prometheus", "metis", "momus", "oracle", "atlas"].filter((n) => nomsAgents.includes(n));
    ajouter("les agents de l'extension sont là (greffon chargé)", propres.length >= 5, `${propres.length}/7 : ${propres.join(", ")}`);
    // `disabled_agents` NE FILTRE PAS `GET /agent` en 4.19.4 : le dist ne s'en sert qu'au moment de DÉLÉGUER, où il rend
    // « Agent "…" is disabled via disabled_agents configuration ». Un agent coupé reste donc affiché, et son absence de la liste
    // ne prouverait rien. Relevé comme mesure, pas comme verdict.
    const coupes = ["librarian", "multimodal-looker"].filter((n) => nomsAgents.includes(n));
    mesures.g2Agents = { total: nomsAgents.length, noms: nomsAgents.sort(), propres, coupesEncoreAffiches: coupes };

    // Ce que la configuration d'INSTANCE pose, et qui est le seul niveau dont le produit dépend : les deux greffons, le
    // fournisseur unique, l'adresse substituée et l'IA par défaut. C'est mesuré, c'est donc jugé.
    const instance = {
      greffons: Array.isArray(config.json?.plugin) ? config.json.plugin.length : 0,
      fournisseurs: Object.keys(config.json?.provider ?? {}),
      modele: config.json?.model ?? null,
      instantane: config.json?.snapshot ?? null,
    };
    ajouter(
      "la configuration d'INSTANCE est appliquée (fournisseur, IA, instantané git coupé)",
      config.code === 200 && instance.fournisseurs.length === 1 && instance.fournisseurs[0] === "github-copilot" && String(instance.modele).startsWith("github-copilot/") && instance.instantane === false,
      `fournisseur(s) ${instance.fournisseurs.join(", ") || "(aucun)"}, IA ${instance.modele}, snapshot ${instance.instantane}`,
    );
    mesures.g2Instance = instance;

    // `disabled_commands`, lui, retire vraiment les commandes de la table (`loadBuiltinCommands` du dist) : c'est le signal
    // OBSERVABLE que la couche utilisateur d'`omo.jsonc` serait appliquée, et non seulement posée. Mesuré deux fois, il dit
    // qu'elle ne l'est PAS (L21 §4.2, puis la remesure avec `CLAUDE_CONFIG_DIR` posé). Le produit ne s'y fie donc plus — les
    // coupures d'outils sont portées par le filet du cockpit — et ce relevé reste ici comme MESURE, pas comme verdict : le
    // jour où les deux commandes disparaîtront, c'est que l'extension aura commencé à lire cette couche.
    const commandes = await ctx.client.get(`/command?directory=${encodeURIComponent(dossier)}`);
    const nomsCommandes = Array.isArray(commandes.json) ? commandes.json.map((c) => c.name ?? c.id).filter(Boolean) : Object.keys(commandes.json ?? {});
    ctx.ecrireSortie("g2-commandes.json", `${JSON.stringify({ code: commandes.code, noms: [...nomsCommandes].sort() }, null, 2)}\n`);
    const commandesCoupees = ["goal", "stop-continuation"].filter((n) => nomsCommandes.includes(n));
    ajouter(
      "GET /command répond (relevé de la couche utilisateur, sans verdict)",
      commandes.code === 200 && nomsCommandes.length > 0,
      `code ${commandes.code}, ${nomsCommandes.length} commandes ; coupées par omo.jsonc et encore là : ${commandesCoupees.join(", ") || "aucune"}`,
    );
    mesures.g2Commandes = { code: commandes.code, total: nomsCommandes.length, coupesEncorePresentes: commandesCoupees, coucheUtilisateurAppliquee: commandesCoupees.length === 0 };

    // --- 3. F-aa : le greffon déclaré ---------------------------------------------------------------------------------------
    const plugins = Array.isArray(config.json?.plugin) ? config.json.plugin : [];
    ajouter("F-aa : les deux greffons déclarés sont en vigueur", plugins.length === 2 && plugins.some((p) => String(p).includes("oh-my-openagent")) && plugins.some((p) => String(p).includes("cockpit-guard")), plugins.join(" ; "));

    // --- 4. Aucune écriture refusée n'arrête le chargement -----------------------------------------------------------------
    const journal = await ctx.logs("opencode-omo", { lignes: 4000 });
    ctx.ecrireSortie("g2-opencode-omo.log", journal);
    const refusEcriture = [...journal.matchAll(/EROFS|EACCES|read-only file system/gi)].length;
    const servi = agents.code === 200 && config.code === 200;
    ajouter("aucune écriture refusée n'arrête le chargement", servi, `${refusEcriture} trace(s) de refus d'écriture, instance servante : ${servi}`);
    ajouter("le superviseur a franchi ses neuf étapes", /opencode lance \(pid/.test(journal), /opencode lance \(pid/.test(journal) ? "opencode lancé" : "aucune ligne « opencode lance »");
    mesures.g2Refus = { tracesRefusEcriture: refusEcriture, instanceServante: servi };

    // --- 5. ps : aucune installation ---------------------------------------------------------------------------------------
    // Le relevé est pris DANS le conteneur, toutes les 500 ms, pendant 15 s : l'extension est déjà chargée, mais un
    // téléchargement tardif (ce que la porte cherche) se verrait ici comme au démarrage.
    const releves = [];
    for (let i = 0; i < 30; i += 1) {
      const r = await ctx.exec("opencode-omo", ["ps", "-eo", "comm,args"], { delaiMs: 20_000 });
      releves.push(String(r.sortie));
      await ctx.attendre(500);
    }
    const suspects = releves.flatMap((t) => [...t.matchAll(/\b(npm|npx|arborist|bun install|yarn|pnpm)\b/g)].map((m) => m[1]));
    ctx.ecrireSortie("g2-ps.txt", releves.join("\n--- \n"));
    ajouter("ps toutes les 500 ms : ni npm, ni arborist, ni bun install", suspects.length === 0, suspects.length === 0 ? `${releves.length} relevés propres` : `trouvés : ${[...new Set(suspects)].join(", ")}`);
    mesures.g2Ps = { releves: releves.length, suspects: [...new Set(suspects)] };

    // --- 6. Migrations F-t sans effet -------------------------------------------------------------------------------------
    // F-t est le RENOMMAGE d'un `.sisyphus` hérité en `.omo` (audit L20, `migrateLegacyWorkspaceDirectory`). Aucun projet du
    // banc n'a de `.sisyphus` : la migration ne doit rien avoir fait, et surtout rien avoir laissé.
    const traces = Object.entries(vue.workspace).map(([p, c]) => `${p}=${Array.isArray(c) ? c.join("|") : JSON.stringify(c)}`);
    const restesSisyphus = Object.values(vue.workspace).filter((c) => Array.isArray(c) && c.includes(".sisyphus"));
    ajouter("migrations F-t sans effet : aucun .sisyphus renommé", restesSisyphus.length === 0, traces.join(" ; "));
    // Ce que l'extension crée d'elle-même dans un projet OUVERT : son dossier de travail `.omo` (audit L20, écritures disque :
    // `boulder.json`, `plans`, `notepads`). Ce n'est pas F-t, c'est son fonctionnement ; ce qui compte, c'est que le projet
    // seulement PRÉPARÉ n'y ait pas droit — la mesure M31 le vérifie.
    const avecOmo = Object.entries(vue.workspace)
      .filter(([, c]) => Array.isArray(c) && c.includes(".omo"))
      .map(([p]) => p);
    mesures.g2Workspace = { projets: traces, dossierOmoCree: avecOmo };
    ajouter("le dossier de travail `.omo` n'apparaît que dans un projet ouvert", !avecOmo.some((p) => p.includes("projet-temoin")), avecOmo.join(", ") || "aucun");

    // --- 7. /auth-src et oc-data ------------------------------------------------------------------------------------------
    const auth = Array.isArray(vue.authSrc) ? vue.authSrc : [];
    ajouter("/auth-src ne contient que auth.json", auth.length === 1 && auth[0] === "auth.json", JSON.stringify(vue.authSrc));
    const donnees = Array.isArray(vue.donnees) ? vue.donnees : [];
    // `oc-data` est le volume de l'instance PRINCIPALE : il n'est jamais monté ici (D-2b-26). Le dossier de données de la salle
    // est `oc-omo-data`, et il ne porte que ce que la salle a écrit.
    const monte = await ctx.docker(["inspect", "--format", "{{range .Mounts}}{{.Name}} {{end}}", `${ctx.projet}-opencode-omo-1`]);
    const volumes = String(monte.sortie).trim().split(/\s+/).filter(Boolean);
    ajouter("aucun fichier d'oc-data (instance principale) n'est lisible", !volumes.some((v) => v.endsWith("_oc-data") || v.endsWith("_oc-config")), volumes.join(", "));
    mesures.g2Donnees = { authSrc: auth, donneesSalle: donnees, volumes };

    return { points, mesures };
  },
};
