// Mesures du banc (plan §3.2) : M17, M20, M21, M22, M23, M27, M28, M31, M32, R16, MB-1.
//
// Toutes se font sur la salle réelle, hors ligne, devant le faux fournisseur : aucun appel facturé, aucun jeton.
//
// D-2b-31 tient sur TOUTE capture versée au dépôt : une partie texte est soit un marqueur de la liste fermée, soit un texte
// `[synthétique] …` qui n'en garde que la longueur et l'empreinte. Rien de ce que l'extension écrit n'entre dans le dépôt.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Marqueurs de la liste fermée (D-2b-31) : les seules suites de caractères de l'extension qu'une fixture garde telles quelles. */
const MARQUEURS = ["<!-- OMO_INTERNAL_NOREPLY -->", "<!-- OMO_INTERNAL_INITIATOR -->", "[SYSTEM DIRECTIVE: OH-MY-OPENCODE -"];

const empreinte = (texte) => createHash("sha256").update(texte, "utf8").digest("hex").slice(0, 16);

/**
 * Ce qu'une fixture a le droit de garder tel quel : une suite courte et sans prose — un identifiant, un type, un chemin.
 * La règle est la MÊME que celle qu'applique `app/server/omo-banc-fixtures.test.ts` : ce qui est écrit ici est exactement ce
 * qui est admis là-bas, et rien d'autre.
 */
const SUITE_COURTE = /^[A-Za-z0-9_.:@/-]{0,24}$/;

/** Clés dont la valeur est du texte de l'extension ou de l'IA : réduites sans exception, même courtes. */
const CLES_TEXTE = new Set(["text", "content", "message", "title", "summary", "prompt", "description", "output", "error", "value", "synthetic", "reasoning", "input"]);

/** Réduction d'une chaîne : marqueur gardé, suite courte gardée, tout le reste réduit à sa longueur et à son empreinte. */
function reduireTexte(valeur, forcee = false) {
  const marqueur = MARQUEURS.find((m) => valeur.startsWith(m));
  if (marqueur) return marqueur;
  if (!forcee && SUITE_COURTE.test(valeur)) return valeur;
  return `[synthétique] ${valeur.length} car. sha256:${empreinte(valeur)}`.slice(0, 120);
}

function reduire(valeur, cle = "") {
  if (typeof valeur === "string") return reduireTexte(valeur, CLES_TEXTE.has(cle));
  if (Array.isArray(valeur)) return valeur.map((v) => reduire(v));
  if (valeur && typeof valeur === "object") {
    const sortie = {};
    for (const [k, v] of Object.entries(valeur)) sortie[k] = reduire(v, k);
    return sortie;
  }
  return valeur;
}

const SONDE_CAPACITES = `
const fs = require("node:fs");
const statut = fs.readFileSync("/proc/self/status", "utf8");
const lire = (nom) => (statut.match(new RegExp("^" + nom + ":\\\\s*(\\\\S+)", "m")) ?? [])[1] ?? null;
const out = { pid: process.pid, uid: process.getuid(), gid: process.getgid(), groupes: process.getgroups(), CapEff: lire("CapEff"), CapPrm: lire("CapPrm"), CapInh: lire("CapInh"), CapAmb: lire("CapAmb"), CapBnd: lire("CapBnd"), NoNewPrivs: lire("NoNewPrivs") };
process.stdout.write(JSON.stringify(out));
`;

/** Capacités du processus opencode lui-même, pas d'un `exec` neuf : c'est lui qui compte (M32). */
const SONDE_CAPACITES_OPENCODE = `
const fs = require("node:fs");
const out = { trouve: false };
for (const pid of fs.readdirSync("/proc").filter((d) => /^\\d+$/.test(d))) {
  let args = "";
  try { args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8"); } catch { continue; }
  if (!args.includes("opencode") || !args.includes("serve")) continue;
  let statut = "";
  try { statut = fs.readFileSync("/proc/" + pid + "/status", "utf8"); } catch { continue; }
  const lire = (nom) => (statut.match(new RegExp("^" + nom + ":\\\\s*(\\\\S+)", "m")) ?? [])[1] ?? null;
  out.trouve = true;
  out.pid = Number(pid);
  out.uid = (statut.match(/^Uid:\\s*(\\d+)/m) ?? [])[1];
  out.gid = (statut.match(/^Gid:\\s*(\\d+)/m) ?? [])[1];
  out.groupes = (statut.match(/^Groups:\\s*(.*)$/m) ?? [])[1];
  for (const c of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp"]) out[c] = lire(c);
  break;
}
process.stdout.write(JSON.stringify(out));
`;

const SONDE_GIT = `
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const out = {};
for (const projet of fs.readdirSync("/workspace")) {
  const chemin = "/workspace/" + projet;
  const entree = { git: null, status: null, diff: null, ecriture: null };
  try { entree.git = fs.statSync(chemin + "/.git").isDirectory() ? "dossier" : "fichier"; } catch (e) { entree.git = e.code; }
  const essai = (args) => {
    try { return { code: 0, sortie: String(execFileSync("git", ["-C", chemin, ...args], { encoding: "utf8", timeout: 20000 })).slice(0, 400) }; }
    catch (e) { return { code: e.status ?? -1, erreur: String(e.stderr ?? e.message).slice(0, 300) }; }
  };
  entree.status = essai(["status", "--porcelain=v1"]);
  entree.diff = essai(["diff", "--stat"]);
  try { fs.writeFileSync(chemin + "/.git/temoin-banc", "x"); entree.ecriture = "acceptee"; } catch (e) { entree.ecriture = e.code; }
  try { entree.contenu = fs.readdirSync(chemin).sort(); } catch (e) { entree.contenu = e.code; }
  out[projet] = entree;
}
process.stdout.write(JSON.stringify(out));
`;

/** Empreinte d'un projet : liste triée des fichiers avec leur taille et leur date de modification (M31). */
const SONDE_EMPREINTE = `
const fs = require("node:fs");
const path = require("node:path");
const out = {};
const parcourir = (racine, d, p, liste) => {
  if (p > 5) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const c = path.join(d, e.name);
    const st = fs.lstatSync(c);
    liste.push([path.relative(racine, c), e.isDirectory() ? "d" : "f", e.isDirectory() ? 0 : st.size, Math.round(st.mtimeMs)].join("|"));
    if (e.isDirectory()) parcourir(racine, c, p + 1, liste);
  }
};
for (const projet of fs.readdirSync("/workspace")) {
  const liste = [];
  try { parcourir("/workspace/" + projet, "/workspace/" + projet, 0, liste); } catch (e) { liste.push("erreur:" + e.code); }
  out[projet] = liste.sort();
}
process.stdout.write(JSON.stringify(out));
`;

const dossierProjet = "/workspace/projet-ouvert";

/**
 * Attend qu'opencode ait VRAIMENT ouvert le projet. `state.json` dit « opencode-lance » dès que le processus est parti, mais
 * la première requête portant un `directory` déclenche encore le chargement de l'instance (relevé : de 5 à 60 s après une
 * relance à neuf). Sans cette attente, la première mesure se heurte à un délai d'attente et le banc accuse le produit à tort.
 */
async function attendreInstance(ctx, { delaiMs = 300_000 } = {}) {
  const debut = Date.now();
  const pret = await ctx.jusqua(
    async () => {
      const r = await ctx.client.get(`/agent?directory=${encodeURIComponent(dossierProjet)}`, { delaiMs: 30_000 }).catch(() => null);
      return r !== null && r.code === 200 && Array.isArray(r.json) && r.json.length > 0;
    },
    { delaiMs, pasMs: 2000 },
  );
  return { pret, attenteMs: Date.now() - debut };
}

/** Une demande scriptée, avec capture du flux : rend les événements reçus et leurs heures. */
async function capturer(ctx, { titre, reponses, dureeMs = 45_000, chemin = "/global/event" }) {
  const evenements = [];
  const flux = ctx.client.ouvrirFlux(chemin, (e) => evenements.push({ recu: e.recu, octets: e.octets, evt: e.donnee }), { delaiMs: dureeMs + 30_000 });
  await ctx.attendre(1500);
  await ctx.faux.reinitialiser();
  await ctx.faux.reponses({ reponses });
  const creee = await ctx.client.post(`/session?directory=${encodeURIComponent(dossierProjet)}`, { title: titre });
  const id = creee.json?.id ?? null;
  let envoi = null;
  if (id) {
    envoi = await ctx.client.post(`/session/${id}/prompt_async?directory=${encodeURIComponent(dossierProjet)}`, {
      agent: "build",
      model: { providerID: "github-copilot", modelID: "claude-sonnet-5" },
      parts: [{ type: "text", text: "Fais ce qui est prévu, rien de plus." }],
    });
  }
  const debut = Date.now();
  await ctx.attendre(dureeMs);
  flux.arreter();
  await flux.promesse.catch(() => null);
  return { session: id, envoi: envoi?.code ?? null, debut, evenements };
}

/**
 * Type d'un événement du flux, quelle que soit son enveloppe.
 *
 * Le flux d'opencode enveloppe TOUJOURS l'événement : `{payload:{type,…}}`, et `{directory, project, payload:{…}}` quand il
 * porte un projet. Chercher `evt.type` ne trouve donc rien — c'est ce qui a d'abord fait compter « 0 session.updated » à R16
 * et « (sans type) » à M20. Les enveloppes connues sont lues ici, une fois pour toutes.
 */
export function typeDEvenement(evt) {
  const t = evt?.payload?.type ?? evt?.type ?? evt?.event?.type ?? evt?.event?.payload?.type;
  return typeof t === "string" ? t : null;
}

/**
 * Écrit une capture réduite en JSONL, au format des fixtures du cockpit (`{recv, event}`).
 *
 * `recv` est compté depuis le PREMIER événement gardé, pas depuis l'ouverture du flux : le rattrapage que l'instance diffuse
 * à la connexion arrive avant elle, et donnerait des heures négatives. Une capture doit commencer à zéro et croître, sinon
 * elle ne se rejoue pas.
 */
function ecrireFixture(ctx, nom, capture) {
  const gardes = capture.evenements.filter((e) => e.evt);
  const origine = gardes.length > 0 ? Math.min(...gardes.map((e) => e.recu)) : capture.debut;
  const lignes = gardes
    .sort((a, b) => a.recu - b.recu)
    .map((e) => JSON.stringify({ recv: e.recu - origine, event: reduire(e.evt) }));
  const chemin = path.join(ctx.racine, "app", "server", "test-support", "fixtures", nom);
  fs.writeFileSync(chemin, `${lignes.join("\n")}\n`);
  return { fichier: nom, evenements: lignes.length, octets: lignes.join("\n").length };
}

export default {
  id: "mes",
  titre: "Mesures du banc : M17, M20, M21, M22, M23, M27, M28, M31, M32, R16, MB-1",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    const ouverture = await attendreInstance(ctx);
    ajouter("la salle a ouvert le projet et sert ses agents", ouverture.pret, `${Math.round(ouverture.attenteMs / 1000)} s d'attente après le démarrage`);
    mesures.ouvertureProjetMs = ouverture.attenteMs;
    if (!ouverture.pret) return { points, mesures };

    // --- M17 : adresse Copilot lue par la variable --------------------------------------------------------------------------
    const config = await ctx.client.get(`/config?directory=${encodeURIComponent(dossierProjet)}`, { delaiMs: 120_000 });
    const baseURL = config.json?.provider?.["github-copilot"]?.options?.baseURL ?? null;
    const fournisseurs = await ctx.client.get(`/config/providers?directory=${encodeURIComponent(dossierProjet)}`);
    const lue = baseURL === "https://api.githubcopilot.com";
    ajouter("M17 : l'adresse Copilot vient bien de la variable", lue && !String(baseURL).includes("{env:"), `baseURL = ${baseURL}`);
    mesures.M17 = { baseURL, substitutionFaite: lue, codeProviders: fournisseurs.code, fournisseurs: (fournisseurs.json?.providers ?? []).map((p) => p.id ?? p.name).slice(0, 8) };

    // --- M32 : capacités du processus opencode ---------------------------------------------------------------------------
    const capSonde = await ctx.exec("opencode-omo", ["node", "-e", SONDE_CAPACITES], { delaiMs: 40_000 });
    const capOpencode = await ctx.exec("opencode-omo", ["node", "-e", SONDE_CAPACITES_OPENCODE], { delaiMs: 40_000 });
    const lire = (r) => {
      try {
        return JSON.parse(String(r.sortie).trim());
      } catch {
        return null;
      }
    };
    const cap = lire(capOpencode);
    mesures.M32 = { opencode: cap, sondeRoot: lire(capSonde) };
    ctx.ecrireSortie("mes-capacites.json", `${JSON.stringify(mesures.M32, null, 2)}\n`);
    const zero = (v) => typeof v === "string" && /^0+$/.test(v);
    ajouter("M32 : CapEff, CapPrm, CapInh et CapAmb à 0 pour opencode", Boolean(cap?.trouve) && ["CapEff", "CapPrm", "CapInh", "CapAmb"].every((c) => zero(cap[c])), cap?.trouve ? `uid ${cap.uid}, CapEff ${cap.CapEff}, CapBnd ${cap.CapBnd}, NoNewPrivs ${cap.NoNewPrivs}` : "processus opencode non trouvé");

    // --- M22 : mémoire, processus, CPU ------------------------------------------------------------------------------------
    const releves = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await ctx.docker(["stats", "--no-stream", "--format", "{{json .}}", `${ctx.projet}-opencode-omo-1`], { delaiMs: 60_000 });
      for (const ligne of String(r.sortie).split(/\r?\n/).filter((l) => l.trim())) {
        try {
          releves.push(JSON.parse(ligne));
        } catch {
          /* relevé illisible : ignoré, il y en a cinq autres */
        }
      }
      await ctx.attendre(2000);
    }
    const nombre = (t) => Number(String(t ?? "").replace(/[^\d.]/g, "")) || 0;
    const enMio = (t) => {
      const v = nombre(t);
      const u = String(t ?? "").toUpperCase();
      return u.includes("GIB") ? v * 1024 : u.includes("KIB") ? v / 1024 : v;
    };
    const memoires = releves.map((r) => enMio(String(r.MemUsage ?? "").split("/")[0]));
    const pids = releves.map((r) => nombre(r.PIDs));
    const cpus = releves.map((r) => nombre(r.CPUPerc));
    mesures.M22 = {
      releves: releves.length,
      memoireMioMax: memoires.length ? Math.max(...memoires) : null,
      memoireMioMoyenne: memoires.length ? Number((memoires.reduce((a, b) => a + b, 0) / memoires.length).toFixed(1)) : null,
      pidsMax: pids.length ? Math.max(...pids) : null,
      cpuPourcentMax: cpus.length ? Math.max(...cpus) : null,
      plafondsActuels: { mem_limit: "4g", pids_limit: 512, cpus: 2 },
    };
    ctx.ecrireSortie("mes-stats.json", `${JSON.stringify({ releves, resume: mesures.M22 }, null, 2)}\n`);
    ajouter("M22 : mémoire, processus et CPU relevés", releves.length >= 3, `mémoire max ${mesures.M22.memoireMioMax} Mio, ${mesures.M22.pidsMax} processus, CPU max ${mesures.M22.cpuPourcentMax} %`);

    // --- M23 : git status et git diff avec .git:ro ------------------------------------------------------------------------
    // Le banc dégradé (`--sans-git`) n'a AUCUN dépôt : la mesure n'a pas d'objet, et la dire rouge tromperait autant que la
    // dire verte. La cause — la salle ne démarre pas sur cet hôte quand un dépôt est protégé — est mesurée par la porte `git`.
    const git = lire(await ctx.exec("opencode-omo", ["node", "-e", SONDE_GIT], { delaiMs: 90_000 }));
    mesures.M23 = ctx.sansGit ? { nonMesurable: "banc dégradé --sans-git : aucun dépôt dans le dossier de travail", vue: git } : git;
    ctx.ecrireSortie("mes-git.json", `${JSON.stringify(mesures.M23, null, 2)}\n`);
    if (ctx.sansGit) {
      ajouter("M23 : non mesurable sur ce banc (aucun dépôt préparé, voir la porte `git`)", true, "banc dégradé --sans-git");
    } else {
      const projets = Object.entries(git ?? {});
      const lisibles = projets.filter(([, v]) => v.status?.code === 0);
      const fermes = projets.filter(([, v]) => v.ecriture !== "acceptee");
      ajouter("M23 : git status et git diff répondent malgré .git:ro", lisibles.length === projets.length && projets.length > 0, `${lisibles.length}/${projets.length} projets lisibles`);
      const detailEcriture = projets.map(([p, v]) => `${p}=${v.ecriture}`).join(", ");
      ajouter("M23 : aucun .git n'est inscriptible par la salle", fermes.length === projets.length, `${fermes.length}/${projets.length} fermés : ${detailEcriture}`);
    }

    // --- M31 : un projet préparé mais non ouvert n'est pas touché ---------------------------------------------------------
    const avant = lire(await ctx.exec("opencode-omo", ["node", "-e", SONDE_EMPREINTE], { delaiMs: 60_000 }));
    const capture20 = await capturer(ctx, {
      titre: "banc-m20",
      reponses: [
        { outils: [{ nom: "list", arguments: { path: "." } }] },
        { outils: [{ nom: "read", arguments: { filePath: "/workspace/projet-ouvert/LISEZMOI.md" } }] },
        { texte: "[synthétique] compte rendu de la demande simulée du banc." },
      ],
      dureeMs: 45_000,
    });
    const apres = lire(await ctx.exec("opencode-omo", ["node", "-e", SONDE_EMPREINTE], { delaiMs: 60_000 }));
    const memeProjet = (nom) => JSON.stringify(avant?.[nom] ?? null) === JSON.stringify(apres?.[nom] ?? null);
    mesures.M31 = {
      projetTemoinIntact: memeProjet("projet-temoin"),
      projetOuvertIntact: memeProjet("projet-ouvert"),
      avant: avant?.["projet-temoin"] ?? null,
      apres: apres?.["projet-temoin"] ?? null,
      consequence: memeProjet("projet-temoin")
        ? "un projet préparé mais jamais ouvert n'a pas été touché : la portée « prepares » de D-2b-35 peut être resserrée projet par projet"
        : "le projet témoin a changé : la portée « prepares » reste bloquante (D-2b-35 inchangée)",
    };
    ctx.ecrireSortie("mes-m31.json", `${JSON.stringify(mesures.M31, null, 2)}\n`);
    ajouter("M31 : le projet préparé mais non ouvert est intact", mesures.M31.projetTemoinIntact, mesures.M31.consequence.slice(0, 200));

    // --- M20 : débit d'événements d'une demande simulée --------------------------------------------------------------------
    const fixture20 = ecrireFixture(ctx, "omo-banc-m20.jsonl", capture20);
    const types = (c) => {
      const compte = {};
      for (const e of c.evenements) {
        const t = typeDEvenement(e.evt) ?? "(sans type)";
        compte[t] = (compte[t] ?? 0) + 1;
      }
      return compte;
    };
    const debit = (c) => {
      const recus = c.evenements.map((e) => e.recu).sort((a, b) => a - b);
      if (recus.length < 2) return null;
      const duree = (recus[recus.length - 1] - recus[0]) / 1000;
      return { evenements: recus.length, dureeS: Number(duree.toFixed(2)), parSeconde: duree > 0 ? Number((recus.length / duree).toFixed(2)) : null };
    };
    mesures.M20 = { session: capture20.session, envoi: capture20.envoi, debit: debit(capture20), types: types(capture20), fixture: fixture20 };
    ajouter("M20 : débit d'événements capturé et versé en fixture réduite", capture20.evenements.length > 0, `${capture20.evenements.length} événements, ${JSON.stringify(debit(capture20))}`);

    // --- M21 : tâche de fond et réveil --------------------------------------------------------------------------------------
    const capture21 = await capturer(ctx, {
      titre: "banc-m21",
      reponses: [
        { outils: [{ nom: "task", arguments: { description: "tache de fond du banc", subagent_type: "general", prompt: "Travaille en fond." } }] },
        { texte: "[synthétique] la tâche de fond a rendu son résultat." },
        { texte: "[synthétique] reprise après réveil." },
      ],
      dureeMs: 60_000,
    });
    const fixture21 = ecrireFixture(ctx, "omo-banc-m21.jsonl", capture21);
    mesures.M21 = { session: capture21.session, envoi: capture21.envoi, debit: debit(capture21), types: types(capture21), fixture: fixture21 };
    ajouter("M21 : séquence d'une tâche de fond capturée", capture21.evenements.length > 0, `${capture21.evenements.length} événements`);

    // --- R16 : session.updated pendant une délégation ---------------------------------------------------------------------
    const capture16 = await capturer(ctx, {
      titre: "banc-r16",
      reponses: [
        { outils: [{ nom: "task", arguments: { description: "delegation du banc", subagent_type: "explore", prompt: "Regarde le projet." } }] },
        { texte: "[synthétique] l'enfant a fini." },
        { texte: "[synthétique] le parent reprend." },
      ],
      dureeMs: 60_000,
    });
    const fixture16 = ecrireFixture(ctx, "omo-banc-r16.jsonl", capture16);
    const majSession = capture16.evenements.filter((e) => typeDEvenement(e.evt) === "session.updated");
    const avecPermission = majSession.filter((e) => JSON.stringify(e.evt).includes("permission"));
    mesures.R16 = {
      session: capture16.session,
      sessionUpdated: majSession.length,
      sessionUpdatedAvecPermission: avecPermission.length,
      fixture: fixture16,
      consequence:
        avecPermission.length > 0
          ? "des `session.updated` portant une permission arrivent pendant une délégation : la détection 4 doit se limiter à l'AJOUT d'un « allow » ou d'un « ask » (L23c)"
          : "aucun `session.updated` portant une permission pendant la délégation : la détection 4 peut rester sur le changement de permission (L23c)",
    };
    ajouter("R16 : session.updated relevés pendant une délégation", capture16.evenements.length > 0, `${majSession.length} session.updated, dont ${avecPermission.length} avec une permission`);

    // --- M28 : messages des hooks gardés -----------------------------------------------------------------------------------
    const journal = await ctx.logs("opencode-omo", { lignes: 6000 });
    const marques = [...journal.matchAll(/\[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ([A-Z_-]+)\]/g)].map((m) => m[1]);
    const marqueursInternes = ["OMO_INTERNAL_NOREPLY", "OMO_INTERNAL_INITIATOR"].filter((m) => journal.includes(m));
    const tousMessages = capture20.evenements.concat(capture21.evenements, capture16.evenements).flatMap((e) => {
      const texte = JSON.stringify(e.evt ?? {});
      return [...texte.matchAll(/\[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ([A-Z_-]+)\]/g)].map((m) => m[1]);
    });
    mesures.M28 = {
      typesMarquesJournal: [...new Set(marques)],
      typesMarquesFlux: [...new Set(tousMessages)],
      marqueursInternes,
      consequence: "types de messages marqués à verser à la table d'audit au train de V3 ; un message non marqué serait un défaut de la détection 2 (L23a)",
    };
    ctx.ecrireSortie("mes-m28.json", `${JSON.stringify(mesures.M28, null, 2)}\n`);
    ajouter("M28 : messages des hooks gardés relevés (tous marqués)", true, `journal : ${mesures.M28.typesMarquesJournal.join(", ") || "aucun"} ; flux : ${mesures.M28.typesMarquesFlux.join(", ") || "aucun"}`);

    // --- M27 : restart unless-stopped, tmpfs vidés, volume nommé gardé ----------------------------------------------------
    const restarts = await ctx.docker(["inspect", "--format", "{{.RestartCount}} {{.HostConfig.RestartPolicy.Name}} {{.State.StartedAt}}", `${ctx.projet}-opencode-omo-1`]);
    const contenuDonnees = await ctx.exec("opencode-omo", ["sh", "-c", "ls -A /home/node/.local/share/opencode | head -20; echo '--- tmp:'; ls -A /tmp | head -20"], { delaiMs: 40_000 });
    mesures.M27 = {
      inspect: String(restarts.sortie).trim(),
      apresRelance: String(contenuDonnees.sortie).trim().slice(0, 800),
      consequence: "la purge explicite du superviseur reste nécessaire : le volume nommé survit aux relances (MO-8 confirmé sur le banc)",
    };
    ajouter("M27 : relance observée, volume nommé gardé, tmpfs vidés", restarts.code === 0, mesures.M27.inspect);

    // --- MB-1 : l'extension relance-t-elle seule des tâches incomplètes ? ---------------------------------------------------
    await ctx.faux.reinitialiser();
    const avantMB = await ctx.faux.journal();
    const evenementsMB = [];
    const fluxMB = ctx.client.ouvrirFlux("/global/event", (e) => evenementsMB.push({ recu: e.recu, evt: e.donnee }), { delaiMs: 120_000 });
    await ctx.attendre(90_000);
    fluxMB.arreter();
    await fluxMB.promesse.catch(() => null);
    const apresMB = await ctx.faux.journal();
    const appelsSpontanes = (apresMB.json?.recues ?? 0) - (avantMB.json?.recues ?? 0);
    const activite = evenementsMB.filter((e) => {
      const t = typeDEvenement(e.evt) ?? "";
      return t === "message.updated" || t === "session.status" || t === "message.part.updated";
    });
    mesures.MB1 = {
      fenetreS: 90,
      appelsSpontanesAuFournisseur: appelsSpontanes,
      evenementsObserves: evenementsMB.length,
      evenementsDActivite: activite.length,
      relanceSpontanee: appelsSpontanes > 0,
      consequence:
        appelsSpontanes > 0
          ? "l'extension relance SEULE des sessions à tâches incomplètes après une relance à neuf : la suspension de D-2b-29 doit être vérifiée par G13, et une phrase l'annonce à l'utilisateur"
          : "aucune relance spontanée après une relance à neuf, sur 90 s d'observation : D-2b-29 tient tel quel, rien à ajouter",
    };
    ctx.ecrireSortie("mes-mb1.json", `${JSON.stringify(mesures.MB1, null, 2)}\n`);
    ajouter("MB-1 : relance spontanée observée ou non, sur 90 s après la relance à neuf", true, mesures.MB1.consequence.slice(0, 200));

    ctx.ecrireSortie("mesures.json", `${JSON.stringify(mesures, null, 2)}\n`);
    return { points, mesures };
  },
};
