// Porte G12 — les agents de l'IMAGE sont ceux de la table d'audit (spéc. §7.10 l.1228 ; T-L20-b ; D-2b-31).
//
// L20 a audité la 4.19.4 sur l'archive du paquet. Cette porte compare ce qu'en rend l'image RÉELLE, chargée, servante :
// 1. `GET /agent` ne rend AUCUN agent que la table d'audit ne connaisse pas — c'est le sens de la porte : rien d'inattendu ;
// 2. chaque agent que la table dit attendu est bien là (`OpenCode-Builder`, déclaré non attendu, doit rester absent) ;
// 3. aucun `allow` en vigueur sur une permission sensible qui ne soit pas au registre des autorisations communes ;
// 4. les sous-chaînes du `dist` : la version installée est bien la version auditée, et les symboles cités comme preuves par
//    l'audit existent dans l'image. Sans cela, l'audit parlerait d'un autre paquet que celui qui tourne.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Table d'audit. Node 24 lit le TypeScript directement ; en cas de refus, on retombe sur la lecture du source. */
async function tableAudit(racine) {
  const fichier = path.join(racine, "app", "server", "shared", "omo-audit-4.19.4.ts");
  try {
    const mod = await import(pathToFileURL(fichier).href);
    return {
      source: "import",
      agents: mod.AGENTS.map((a) => ({ nom: a.cle, attendu: a.attendu !== false, decision: a.decision })),
      agentsOpencode: mod.AGENTS_OPENCODE.map((a) => ({ nom: a.cle, attendu: true, decision: a.decision })),
      permissionsSensibles: [...mod.PERMISSIONS_SENSIBLES],
      autorisationsCommunes: mod.AUTORISATIONS_OPENCODE.map((a) => ({ permission: a.permission, pattern: a.pattern })),
      preuves: [...new Set([...mod.DISQUE, ...(mod.RESEAU ?? [])].map((f) => f.preuve?.symbole).filter(Boolean))],
      version: mod.OMO_VERSION,
    };
  } catch (err) {
    // Repli : la table est lue comme du texte. Le banc dit alors par quelle voie il l'a lue, et pourquoi l'autre a échoué.
    const texte = fs.readFileSync(fichier, "utf8");
    const bloc = (nom) => texte.slice(texte.indexOf(`export const ${nom}`), texte.indexOf(";", texte.indexOf(`export const ${nom}`)) + 1);
    const noms = (nom) => [...bloc(nom).matchAll(/AGENT\("([^"]+)"/g)].map((m) => m[1]);
    return {
      source: `source (${String(err?.message ?? err).slice(0, 80)})`,
      agents: noms("AGENTS").map((n) => ({ nom: n, attendu: n !== "OpenCode-Builder", decision: "?" })),
      agentsOpencode: noms("AGENTS_OPENCODE").map((n) => ({ nom: n, attendu: true, decision: "?" })),
      permissionsSensibles: ["edit", "bash", "task", "webfetch", "websearch", "external_directory", "read"],
      autorisationsCommunes: [],
      preuves: [...new Set([...texte.matchAll(/symbole: "(\w+)"/g)].map((m) => m[1]))],
      version: (/OMO_VERSION = "([^"]+)"/.exec(texte) ?? [])[1] ?? "?",
    };
  }
}

/**
 * Clé d'un agent rendu par `GET /agent`, relevée sur l'image réelle : l'extension y met un nom d'affichage
 * (« Sisyphus - ultraworker », « Atlas - Plan Executor »), là où la table d'audit nomme la clé de configuration
 * (« sisyphus », « atlas »). La partie qui précède le tiret entouré d'espaces est cette clé ; les agents d'opencode
 * (« build », « plan », « general »…) et ceux qui n'ont pas de tiret (« Sisyphus-Junior ») passent tels quels.
 */
export const cleAgent = (nom) => String(nom).split(" - ")[0].trim().toLowerCase();

/** Clé d'une autorisation : le couple permission/motif, rendu comparable sans séparateur ambigu. */
const cleAutorisation = (permission, motif) => JSON.stringify([permission, motif]);

/** Relevé du `dist` de l'image : version installée, taille, et présence des symboles cités en preuve par l'audit. */
function scriptDist(symboles) {
  return `
const fs = require("node:fs");
const path = require("node:path");
const racine = "/opt/omo/node_modules/oh-my-openagent";
const out = { version: null, dist: 0, octets: 0, symboles: {}, skills: 0 };
out.version = JSON.parse(fs.readFileSync(path.join(racine, "package.json"), "utf8")).version;
const fichiers = [];
const parcourir = (d, profondeur) => {
  if (profondeur > 8) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) parcourir(p, profondeur + 1);
    else if (e.isFile() && /\\.(js|mjs|cjs)$/.test(e.name)) fichiers.push(p);
    else if (e.isFile() && e.name === "SKILL.md") out.skills += 1;
  }
};
parcourir(path.join(racine, "dist"), 0);
out.dist = fichiers.length;
const symboles = ${JSON.stringify(symboles)};
for (const s of symboles) out.symboles[s] = 0;
for (const f of fichiers) {
  const t = fs.readFileSync(f, "utf8");
  out.octets += t.length;
  for (const s of symboles) if (t.includes(s)) out.symboles[s] += 1;
}
process.stdout.write(JSON.stringify(out));
`;
}

export default {
  id: "g12",
  titre: "Agents et sous-chaînes : l'image rend la table d'audit de la 4.19.4",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    const table = await tableAudit(ctx.racine);
    const dossier = "/workspace/projet-ouvert";
    const reponse = await ctx.client.get(`/agent?directory=${encodeURIComponent(dossier)}`);
    const rendus = Array.isArray(reponse.json) ? reponse.json : [];
    const affiches = rendus
      .map((a) => a.name ?? a.id)
      .filter(Boolean)
      .sort();
    const noms = [...new Set(affiches.map(cleAgent))].sort();
    const detailRendus = rendus.map((a) => ({ nom: a.name ?? a.id, cle: cleAgent(a.name ?? a.id), mode: a.mode, permission: a.permission }));
    ctx.ecrireSortie("g12-agents.json", `${JSON.stringify({ code: reponse.code, tableLue: table.source, affiches, noms, rendus: detailRendus }, null, 2)}\n`);
    ajouter("GET /agent répond", reponse.code === 200 && noms.length > 0, `code ${reponse.code}, ${noms.length} agents`);

    // La table nomme les clés de configuration, `GET /agent` rend des noms d'affichage : les deux passent par `cleAgent`.
    const connus = new Set([...table.agents, ...table.agentsOpencode].map((a) => cleAgent(a.nom)));
    const inconnus = noms.filter((n) => !connus.has(n));
    ajouter("aucun agent hors de la table d'audit", inconnus.length === 0, inconnus.join(", ") || "aucun");

    const attendus = [...table.agents, ...table.agentsOpencode].filter((a) => a.attendu).map((a) => cleAgent(a.nom));
    const manquants = attendus.filter((n) => !noms.includes(n));
    // Un agent que la table dit « couper » est coupé par `disabled_agents` d'omo.jsonc : son absence est attendue, pas un manque.
    const coupes = new Set(table.agents.filter((a) => a.decision === "couper").map((a) => cleAgent(a.nom)));
    const manquantsVrais = manquants.filter((n) => !coupes.has(n));
    ajouter(
      "chaque agent attendu par la table est là",
      manquantsVrais.length === 0,
      `manquants : ${manquants.join(", ") || "aucun"} ; dont coupés par la configuration : ${manquants.filter((n) => coupes.has(n)).join(", ") || "aucun"}`,
    );
    const builder = cleAgent("OpenCode-Builder");
    ajouter("OpenCode-Builder reste absent (default_builder_enabled à false)", !noms.includes(builder), noms.includes(builder) ? "présent" : "absent");

    // --- Permissions en vigueur -------------------------------------------------------------------------------------------
    const communes = new Set(table.autorisationsCommunes.map((a) => cleAutorisation(a.permission, a.pattern)));
    const allowInattendus = [];
    for (const agent of rendus) {
      const perms = agent.permission ?? {};
      for (const [permission, valeur] of Object.entries(perms)) {
        if (!table.permissionsSensibles.includes(permission)) continue;
        const regles = typeof valeur === "string" ? { "*": valeur } : (valeur ?? {});
        for (const [motif, action] of Object.entries(regles)) {
          if (action !== "allow" || communes.has(cleAutorisation(permission, motif))) continue;
          allowInattendus.push({ agent: cleAgent(agent.name ?? agent.id), permission, motif });
        }
      }
    }
    ctx.ecrireSortie("g12-permissions.json", `${JSON.stringify({ communes: table.autorisationsCommunes, allowInattendus }, null, 2)}\n`);
    ajouter(
      "aucun « allow » sensible hors des autorisations communes",
      allowInattendus.length === 0,
      `${allowInattendus.length} : ${allowInattendus
        .slice(0, 6)
        .map((a) => `${a.agent}/${a.permission}=${a.motif}`)
        .join(", ")}`,
    );

    // --- Sous-chaînes du dist ----------------------------------------------------------------------------------------------
    const r = await ctx.docker(
      ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--entrypoint", "node", ctx.image, "-e", scriptDist(table.preuves.slice(0, 24))],
      { delaiMs: 300_000 },
    );
    let dist = null;
    try {
      dist = JSON.parse(String(r.sortie).trim());
    } catch {
      dist = null;
    }
    ctx.ecrireSortie("g12-dist.json", `${JSON.stringify(dist ?? { brut: String(r.sortie).slice(0, 1500), erreur: String(r.erreur).slice(0, 800) }, null, 2)}\n`);
    if (dist) {
      ajouter("la version installée est la version auditée", dist.version === table.version, `image ${dist.version}, audit ${table.version}`);
      const trouves = Object.entries(dist.symboles)
        .filter(([, n]) => n > 0)
        .map(([s]) => s);
      const absents = Object.entries(dist.symboles)
        .filter(([, n]) => n === 0)
        .map(([s]) => s);
      // L'audit a lu les SOURCES du paquet ; le `dist` est empaqueté. Un tiers de symboles renommés est admis, pas davantage :
      // au-delà, l'audit ne parlerait plus du code qui tourne.
      ajouter(
        "les symboles cités en preuve par l'audit sont dans le dist",
        trouves.length > 0 && absents.length <= Math.floor(Object.keys(dist.symboles).length / 3),
        `${trouves.length} trouvés, ${absents.length} absents : ${absents.slice(0, 8).join(", ")}`,
      );
      mesures.g12Dist = { version: dist.version, fichiers: dist.dist, octets: dist.octets, skills: dist.skills, symbolesTrouves: trouves.length, symbolesAbsents: absents };
    } else {
      ajouter("sous-chaînes du dist lisibles", false, String(r.erreur).slice(0, 300));
    }

    // --- Licence (T-L15-g) et absence sans profil (T-L16-g) ---------------------------------------------------------------
    const licence = await ctx.docker(
      ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--entrypoint", "sh", ctx.image, "-c", "wc -c < /usr/share/doc/oh-my-openagent/LICENSE.md"],
      { delaiMs: 60_000 },
    );
    const octetsLicence = Number(String(licence.sortie).trim());
    ajouter("T-L15-g : la licence de l'extension est dans l'image", licence.code === 0 && octetsLicence > 100, `${octetsLicence} octets`);

    const sansProfil = await ctx.docker(["compose", "--project-name", ctx.projet, "--env-file", ctx.chemins.env, "--file", path.join(ctx.racine, "docker-compose.yml"), "config", "--services"], {
      cwd: ctx.racine,
      delaiMs: 120_000,
    });
    const services = String(sansProfil.sortie)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    ajouter("T-L16-g : opencode-omo absent sans le profil omo", !services.includes("opencode-omo") && !services.includes("egress"), services.join(", "));
    mesures.g12Sortie = { agents: noms, inconnus, manquants, licenceOctets: octetsLicence, servicesSansProfil: services };

    return { points, mesures };
  },
};
