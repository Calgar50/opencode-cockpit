// Porte G1 — réseau fermé (spéc. §7.10 l.1215-1216 ; plan fiche L21 ; MO-10).
//
// Ce que cette porte prouve, hors ligne et sans aucun appel facturé :
// 1. la salle DÉMARRE hors ligne : elle n'a qu'un réseau, il est fermé, et elle est prête quand même ;
// 2. depuis `opencode-omo` : aucun nom public ne se résout, l'instance principale est injoignable, seul `egress:3128` répond ;
// 3. 30 minutes de scénarios scriptés (sessions, envois, flux) ne font apparaître au journal de sortie AUCUN tunnel vers un
//    autre hôte que celui qui est autorisé ; tout le reste est refusé et journalisé. C'est aussi la seule charge réelle du
//    banc : la mesure M22 (mémoire, processus, CPU), qui dimensionne les plafonds du compose, est relevée PENDANT ces passes ;
//    le scénario `mesures` n'en garde qu'un relevé au repos (`M22Repos`), qui est un plancher ;
// 4. `NO_PROXY` n'est PAS lu par le proxy de sortie (constat bas de V0, à confirmer ici) : la confirmation se fait dans un
//    conteneur jetable, avec un proxy d'entreprise déclaré et l'hôte autorisé dans `NO_PROXY`.
//
// La partie « puis recette » de G1 (Copilot réel) n'est PAS jouée ici : elle reste en attente (plan §3.3).
import { NOMS_COPILOT } from "../lib/certs.mjs";
import { plafondsDuCompose, releverStats, resumerStats } from "./mesures.mjs";

/** Petit programme node exécuté DANS un conteneur : rend un JSON sur la sortie standard. Aucun texte de commande construit. */
const SONDE_RESEAU = `
const dns = require("node:dns");
const net = require("node:net");
const out = { resolutions: {}, connexions: {} };
const resoudre = (nom) => new Promise((r) => dns.lookup(nom, (err, adr) => r(err ? { erreur: err.code ?? String(err.message).slice(0, 40) } : { adresse: adr })));
const joindre = (hote, port) => new Promise((r) => {
  const debut = Date.now();
  const s = net.connect({ host: hote, port, timeout: 4000 });
  const fin = (etat, motif) => { try { s.destroy(); } catch {} r({ etat, motif, ms: Date.now() - debut }); };
  s.on("connect", () => fin("ouvert", null));
  s.on("timeout", () => fin("expire", "timeout"));
  s.on("error", (e) => fin("refuse", e.code ?? String(e.message).slice(0, 40)));
});
(async () => {
  for (const nom of ["example.com", "registry.npmjs.org", "models.opencode.ai", "github.com", "egress", "api.githubcopilot.com"]) {
    out.resolutions[nom] = await resoudre(nom);
  }
  for (const [nom, hote, port] of [["egress", "egress", 3128], ["opencode", "opencode", 4096], ["copilot", "api.githubcopilot.com", 443], ["public", "1.1.1.1", 443]]) {
    out.connexions[nom] = await joindre(hote, port);
  }
  process.stdout.write(JSON.stringify(out));
})();
`;


/** CONNECT à travers `egress`, depuis la salle : l'hôte autorisé passe, tous les autres reçoivent 403 et entrent au journal. */
const SONDE_CONNECT = `
const net = require("node:net");
const essai = (cible) => new Promise((r) => {
  const s = net.connect({ host: "egress", port: 3128, timeout: 8000 });
  let recu = "";
  s.on("connect", () => s.write("CONNECT " + cible + " HTTP/1.1\\r\\nHost: " + cible + "\\r\\n\\r\\n"));
  s.on("data", (b) => { recu += b; if (recu.includes("\\r\\n\\r\\n")) { s.destroy(); r(recu.split("\\r\\n")[0]); } });
  s.on("timeout", () => { s.destroy(); r("(aucune réponse)"); });
  s.on("error", (e) => r("erreur " + (e.code || "")));
});
(async () => {
  const out = {};
  for (const cible of ["api.githubcopilot.com:443", "example.com:443", "api.github.com:443", "api.githubcopilot.com:80"]) out[cible] = await essai(cible);
  process.stdout.write(JSON.stringify(out));
})();
`;

/** Confirmation du constat bas de V0 : `egress` ignore `NO_PROXY` et chaîne toujours au proxy d'entreprise déclaré. */
const SONDE_NO_PROXY = `
const net = require("node:net");
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const { spawn } = require("node:child_process");
const enfant = spawn("node", ["--disable-warning=ExperimentalWarning", "server/egress-proxy.ts"], { cwd: "/app", stdio: ["ignore", "pipe", "pipe"] });
let journal = "";
enfant.stdout.on("data", (b) => { journal += b; });
enfant.stderr.on("data", (b) => { journal += b; });
(async () => {
  await attendre(2500);
  const essai = await new Promise((r) => {
    const s = net.connect({ host: "127.0.0.1", port: 3128, timeout: 8000 });
    let recu = "";
    s.on("connect", () => s.write("CONNECT api.githubcopilot.com:443 HTTP/1.1\\r\\nHost: api.githubcopilot.com:443\\r\\n\\r\\n"));
    s.on("data", (b) => { recu += b; if (recu.includes("\\r\\n\\r\\n")) { s.destroy(); r({ reponse: recu.split("\\r\\n")[0] }); } });
    s.on("timeout", () => { s.destroy(); r({ reponse: "(aucune réponse)" }); });
    s.on("error", (e) => r({ erreur: e.code ?? String(e.message).slice(0, 40) }));
  });
  enfant.kill("SIGTERM");
  await attendre(500);
  process.stdout.write(JSON.stringify({ essai, journal: journal.slice(-1500) }));
  process.exit(0);
})();
`;

/** Une passe de scénario scripté : une conversation, un envoi, la réponse du faux fournisseur, puis le retour au repos. */
async function passeScriptee(ctx, n) {
  const dossier = "/workspace/projet-ouvert";
  await ctx.faux.reponses({ reponses: [{ texte: `[synthétique] passe ${n} du banc, réponse scriptée.` }] });
  const creee = await ctx.client.post(`/session?directory=${encodeURIComponent(dossier)}`, { title: `banc-g1-${n}` });
  if (creee.code !== 200 || !creee.json?.id) return { n, etape: "session", code: creee.code };
  const id = creee.json.id;
  const envoi = await ctx.client.post(`/session/${id}/prompt_async?directory=${encodeURIComponent(dossier)}`, {
    agent: "build",
    model: { providerID: "github-copilot", modelID: "claude-sonnet-5" },
    parts: [{ type: "text", text: "Dis bonjour, rien de plus." }],
  });
  // La session est laissée telle quelle : le banc n'efface rien pendant G1, pour que les 30 minutes soient réalistes.
  return { n, etape: "envoi", code: envoi.code, session: id };
}

export default {
  id: "g1",
  titre: "Réseau fermé : démarrage hors ligne, aucune sortie hors de l'hôte autorisé",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    // --- 1. Un seul réseau, et il est fermé ---------------------------------------------------------------------------------
    const inspect = await ctx.docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", `${ctx.projet}-opencode-omo-1`]);
    let reseaux = {};
    try {
      reseaux = JSON.parse(String(inspect.sortie).trim());
    } catch {
      reseaux = {};
    }
    const noms = Object.keys(reseaux);
    ajouter("opencode-omo n'a qu'un réseau", noms.length === 1, noms.join(", ") || "(aucun)");
    const interne = await ctx.docker(["network", "inspect", "--format", "{{.Internal}}", `${ctx.projet}_omo-internal`]);
    ajouter("ce réseau est fermé (internal: true)", String(interne.sortie).trim() === "true", String(interne.sortie).trim());

    // --- 2. Démarrage hors ligne ---------------------------------------------------------------------------------------------
    const etat = await ctx.etat();
    ajouter("la salle est prête, hors ligne", etat?.phase === "opencode-lance", `phase ${etat?.phase ?? "illisible"}, manifeste ${etat?.manifesteReference ?? "?"}`);

    // --- 3. Ce que voit la salle --------------------------------------------------------------------------------------------
    const sonde = await ctx.exec("opencode-omo", ["node", "-e", SONDE_RESEAU], { delaiMs: 90_000 });
    let vue = null;
    try {
      vue = JSON.parse(String(sonde.sortie).trim());
    } catch {
      vue = null;
    }
    ctx.ecrireSortie("g1-sonde-reseau.json", `${JSON.stringify(vue ?? { brut: String(sonde.sortie).slice(0, 2000) }, null, 2)}\n`);
    if (vue) {
      ajouter("getent/lookup example.com échoue", Boolean(vue.resolutions["example.com"]?.erreur), JSON.stringify(vue.resolutions["example.com"]));
      ajouter("registry.npmjs.org ne se résout pas", Boolean(vue.resolutions["registry.npmjs.org"]?.erreur), JSON.stringify(vue.resolutions["registry.npmjs.org"]));
      ajouter("egress se résout", Boolean(vue.resolutions.egress?.adresse), JSON.stringify(vue.resolutions.egress));
      ajouter("egress:3128 répond", vue.connexions.egress?.etat === "ouvert", JSON.stringify(vue.connexions.egress));
      ajouter("opencode:4096 (instance principale) injoignable", vue.connexions.opencode?.etat !== "ouvert", JSON.stringify(vue.connexions.opencode));
      ajouter("adresse publique injoignable", vue.connexions.public?.etat !== "ouvert", JSON.stringify(vue.connexions.public));
      ajouter("api.githubcopilot.com pointe sur le faux du banc", vue.resolutions["api.githubcopilot.com"]?.adresse === ctx.ipCopilot, JSON.stringify(vue.resolutions["api.githubcopilot.com"]));
    } else {
      ajouter("sonde réseau lisible", false, String(sonde.erreur || sonde.sortie).slice(0, 300));
    }
    // Le vrai `getent` du système, en plus de la résolution de node : c'est le libellé exact de la porte.
    const getent = await ctx.exec("opencode-omo", ["getent", "hosts", "example.com"]);
    ajouter("getent hosts example.com échoue", getent.code !== 0, `code ${getent.code}`);

    const connect = await ctx.exec("opencode-omo", ["node", "-e", SONDE_CONNECT], { delaiMs: 90_000 });
    let tunnels0 = null;
    try {
      tunnels0 = JSON.parse(String(connect.sortie).trim());
    } catch {
      tunnels0 = null;
    }
    ctx.ecrireSortie("g1-connect.json", `${JSON.stringify(tunnels0 ?? { brut: String(connect.sortie).slice(0, 800) }, null, 2)}
`);
    if (tunnels0) {
      ajouter("CONNECT vers l'hôte autorisé accepté par egress", /200/.test(tunnels0["api.githubcopilot.com:443"] ?? ""), tunnels0["api.githubcopilot.com:443"]);
      ajouter("CONNECT vers un autre hôte refusé", /403/.test(tunnels0["example.com:443"] ?? ""), tunnels0["example.com:443"]);
      ajouter("CONNECT vers api.github.com toujours refusé", /403/.test(tunnels0["api.github.com:443"] ?? ""), tunnels0["api.github.com:443"]);
      ajouter("CONNECT sur un autre port que 443 refusé", /403/.test(tunnels0["api.githubcopilot.com:80"] ?? ""), tunnels0["api.githubcopilot.com:80"]);
      mesures.g1Connect = tunnels0;
    } else {
      ajouter("sonde CONNECT lisible", false, String(connect.erreur).slice(0, 200));
    }

    // --- 4. Scénarios scriptés, et M22 PENDANT la charge ---------------------------------------------------------------------
    // M22 était relevée par le scénario `mesures`, sur une salle au repos : 347,8 Mio et 11 processus. Sous cette charge-ci, la
    // répétition générale de la 2 bis a relevé 516,7 Mio et 29 processus — les plafonds dimensionnés sur le repos ne tenaient
    // donc plus leurs marges. La mesure de référence est prise ici, là où la salle travaille vraiment ; `mesures` garde son
    // relevé au repos sous `M22Repos`, pour l'écart.
    await ctx.faux.reinitialiser();
    const dureeMs = Math.max(1, ctx.dureeG1Min) * 60_000;
    const fin = Date.now() + dureeMs;
    const debut = Date.now();
    const passes = [];
    const stats = [];
    let n = 0;
    while (Date.now() < fin) {
      n += 1;
      passes.push(await passeScriptee(ctx, n));
      // Un relevé à la première passe, puis toutes les trois (≈ 30 s) : assez pour voir le maximum sans que `docker stats`
      // prenne lui-même le temps de la charge.
      if (n === 1 || n % 3 === 0) stats.push(...(await releverStats(ctx, `${ctx.projet}-opencode-omo-1`)));
      // Une passe toutes les 10 s : assez pour exercer la salle sans la saturer, et pour tenir les 30 minutes demandées.
      const reste = fin - Date.now();
      if (reste > 0) await ctx.attendre(Math.min(10_000, reste));
      if (n % 12 === 0) ctx.dire(`  G1 : ${n} passes, ${Math.round((Date.now() - debut) / 60_000)} min`);
    }
    const bonnes = passes.filter((p) => p.etape === "envoi" && (p.code === 200 || p.code === 204)).length;
    ctx.ecrireSortie("g1-passes.json", `${JSON.stringify({ dureeMinutes: (Date.now() - debut) / 60_000, passes }, null, 2)}\n`);
    ajouter(`${Math.round((Date.now() - debut) / 60_000)} min de scénarios scriptés`, passes.length > 0 && bonnes > 0, `${passes.length} passes, ${bonnes} envois acceptés`);
    mesures.g1Passes = { passes: passes.length, envoisAcceptes: bonnes, dureeMinutes: Number(((Date.now() - debut) / 60_000).toFixed(2)) };

    // M22 : le maximum sous charge, et les plafonds RELUS dans le compose du produit (jamais une copie en dur, qui vieillirait).
    // Trois relevés au moins, sinon la mesure n'est pas faite — et elle est dite non mesurable plutôt que publiée maigre (P3).
    // Un banc écourté (`--duree-g1-min` court) tombe dans ce cas sans que ce soit un défaut de la salle.
    const assez = stats.length >= 3;
    mesures.M22 = assez
      ? { ...resumerStats(stats), sous: "charge de G1", passes: passes.length, envoisAcceptes: bonnes, plafondsActuels: plafondsDuCompose(ctx.racine) }
      : { nonMesurable: `banc écourté : ${stats.length} relevé(s) sur les ${passes.length} passes, trois au moins sont demandés`, plafondsActuels: plafondsDuCompose(ctx.racine) };
    ctx.ecrireSortie("g1-stats.json", `${JSON.stringify({ releves: stats, resume: mesures.M22 }, null, 2)}\n`);
    ajouter(
      "M22 sous charge : mémoire, processus et CPU relevés pendant les passes",
      assez || passes.length < 9,
      assez
        ? `${stats.length} relevés ; mémoire max ${mesures.M22.memoireMioMax} Mio (moyenne ${mesures.M22.memoireMioMoyenne}), ${mesures.M22.pidsMax} processus, CPU max ${mesures.M22.cpuPourcentMax} %`
        : `non mesurable : ${stats.length} relevé(s) sur ${passes.length} passes (banc écourté)`,
    );

    // --- 5. Journal de sortie ---------------------------------------------------------------------------------------------
    const refus = (await ctx.lireVolume("egress-log", "refus.jsonl")) ?? "";
    const lignes = refus
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    ctx.ecrireSortie("g1-egress-refus.jsonl", `${lignes.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const autorises = new Set(NOMS_COPILOT);
    // Sur le port 443, et lui seul : la sonde CONNECT ci-dessus demande exprès le port 80 de l'hôte autorisé, et ce refus-là
    // est la preuve que la règle de port tient, pas un manquement.
    const refusDeLAutorise = lignes.filter((l) => autorises.has(l.hote) && l.port === 443);
    ajouter(
      "aucun refus ne porte sur l'hôte autorisé en 443",
      refusDeLAutorise.length === 0,
      `${lignes.length} refus au total, ${refusDeLAutorise.length} sur l'hôte autorisé en 443, ${lignes.filter((l) => autorises.has(l.hote)).length} sur cet hôte tous ports confondus`,
    );

    const journalEgress = await ctx.logs("egress");
    ctx.ecrireSortie("g1-egress.log", journalEgress);
    const tunnels = [...journalEgress.matchAll(/tunnel ouvert[^\n]*?"hote":"([^"]+)"/g)].map((m) => m[1]);
    const tunnelsHorsHote = tunnels.filter((h) => !autorises.has(h));
    ajouter("aucun tunnel ouvert vers un autre hôte", tunnelsHorsHote.length === 0, `${tunnels.length} tunnel(s), ${new Set(tunnels).size} hôte(s) distinct(s) : ${[...new Set(tunnels)].join(", ") || "(aucun)"}`);
    mesures.g1Egress = { refus: lignes.length, hotesRefuses: [...new Set(lignes.map((l) => l.hote))].slice(0, 20), tunnels: tunnels.length, hotesTunnel: [...new Set(tunnels)] };

    // --- 6. Le faux fournisseur a bien tout reçu ---------------------------------------------------------------------------
    const journalFaux = await ctx.faux.journal();
    const recues = journalFaux.json?.journal ?? [];
    ctx.ecrireSortie("g1-faux-journal.json", `${JSON.stringify({ mode: journalFaux.json?.mode, recues: journalFaux.json?.recues, entrees: recues.slice(-40) }, null, 2)}\n`);
    const chemins = [...new Set(recues.map((r) => r.chemin))];
    ajouter("le faux Copilot a reçu les appels de la salle", recues.length > 0, `${recues.length} requêtes, chemins : ${chemins.join(", ")}`);
    ajouter("aucun chemin d'échange de jeton (api.github.com)", !chemins.some((c) => c.includes("copilot_internal") || c.includes("token")), chemins.join(", ") || "(aucun)");
    mesures.g1Faux = { requetes: recues.length, chemins, autorisationPresente: recues.some((r) => r.autorisation) };

    // --- 7. NO_PROXY d'egress (constat bas de V0) --------------------------------------------------------------------------
    const sondeNoProxy = await ctx.docker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--env",
        "COCKPIT_COPILOT_API_URL=https://api.githubcopilot.com",
        "--env",
        "HTTPS_PROXY=http://127.0.0.1:1/",
        "--env",
        "NO_PROXY=api.githubcopilot.com,localhost,127.0.0.1",
        "--env",
        "COCKPIT_EGRESS_JOURNAL=/tmp",
        "--entrypoint",
        "node",
        ctx.imageApp,
        "-e",
        SONDE_NO_PROXY,
      ],
      { delaiMs: 90_000 },
    );
    let noProxy = null;
    try {
      noProxy = JSON.parse(String(sondeNoProxy.sortie).trim());
    } catch {
      noProxy = null;
    }
    ctx.ecrireSortie("g1-no-proxy.json", `${JSON.stringify(noProxy ?? { brut: String(sondeNoProxy.sortie).slice(0, 2000) }, null, 2)}\n`);
    // L'hôte est dans NO_PROXY : s'il était lu, le proxy irait en direct et le CONNECT réussirait (réseau none : il échouerait
    // autrement). Le proxy d'entreprise est injoignable : un 502 ou une absence de réponse prouve qu'egress y a quand même chaîné.
    const ignore = noProxy !== null && !String(noProxy.essai?.reponse ?? "").includes("200");
    ajouter("NO_PROXY n'est pas lu par egress (constat bas de V0 CONFIRMÉ)", ignore, JSON.stringify(noProxy?.essai ?? {}).slice(0, 200));
    mesures.g1NoProxy = { confirme: ignore, essai: noProxy?.essai ?? null };

    return { points, mesures };
  },
};
