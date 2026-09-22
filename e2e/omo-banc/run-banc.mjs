// Banc hors ligne de la Salle OMO (L21) : monte la salle réelle, hors ligne, devant un faux Copilot, et joue les portes.
//
//   node e2e/omo-banc/run-banc.mjs --a-blanc           commandes affichées, refus vérifiés, aucun Docker
//   node e2e/omo-banc/run-banc.mjs --id l21            banc réel, projet sal11-omo-banc-l21
//   node e2e/omo-banc/run-banc.mjs --id l21 --scenarios g2,g9
//
// Ce que le banc est, et n'est pas :
// - il lance l'IMAGE réelle de la salle (opencode 1.18.30 + Oh My OpenAgent 4.19.4), avec le compose du produit, la surcharge
//   des projets d'`install.ps1 -OmoProjetsSeulement` et sa propre surcharge ; rien du produit n'est modifié pour lui ;
// - il ne lance PAS le cockpit (ce banc-là est L21b) : trois pilotes tiennent la place du cockpit pour le battement,
//   l'authentification et le pré-contrôle, et rien d'autre ;
// - il ne sort JAMAIS sur Internet : `opencode-omo` ne voit que `omo-internal` (fermé), et le seul hôte que le proxy de sortie
//   accepte est détourné vers le faux fournisseur (L21a) par `extra_hosts` ;
// - il n'emploie AUCUN jeton : l'`auth.json` posé est factice, à `expires` lointain, ce qui évite tout aller-retour vers
//   `api.github.com` (MO-9). Aucun appel n'est facturé.
//
// Garde-fous, dans cet ordre, avant la moindre commande Docker : nom de projet (`sal11-omo-banc-*` et rien d'autre), verrou,
// existence des trois fichiers compose. Le nettoyage tourne même en échec, et ne touche que le projet du banc.
//
// Aucune dépendance npm (P8) : modules `node:` seulement.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { fabriquerCertificats, NOMS_COPILOT } from "./lib/certs.mjs";
import { clientOmo, piloteFaux, requete } from "./lib/client.mjs";
import {
  attendre,
  BancRefus,
  docker,
  dockerOuEchec,
  ETIQUETTE_BANC,
  jusqua,
  lancer,
  nettoyerProjet,
  nomDeProjet,
  pileUtilisateur,
  PREFIXE_PROJET,
  prendreVerrou,
  restes,
  verifierProjet,
} from "./lib/verrou.mjs";

import g1 from "./scenarios/g1-reseau.mjs";
import g2 from "./scenarios/g2-chargement.mjs";
import g9 from "./scenarios/g9-pilote.mjs";
import g12 from "./scenarios/g12-agents.mjs";
import g14 from "./scenarios/g14-configuration.mjs";
import git from "./scenarios/git-protection.mjs";
import mes from "./scenarios/mesures.mjs";
import sul from "./scenarios/sul-sous-chaines.mjs";

// L'ordre compte : `git` sonde le dossier de travail avant que quoi que ce soit ne l'ouvre, G9 coupe la salle et la remet en
// marche, les mesures veulent une salle vivante, G14 et SUL n'en ont pas besoin.
const SCENARIOS = [git, g1, g2, g12, g9, mes, g14, sul];

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const BANC = import.meta.dirname;

const { values } = parseArgs({
  options: {
    "a-blanc": { type: "boolean" },
    id: { type: "string" },
    image: { type: "string" },
    "image-app": { type: "string" },
    scenarios: { type: "string" },
    "duree-g1-min": { type: "string" },
    "image-base": { type: "string" },
    contournement: { type: "boolean" },
    "sans-git": { type: "boolean" },
    "ecrire-fixtures": { type: "boolean" },
    base: { type: "string" },
    garder: { type: "boolean" },
    aide: { type: "boolean" },
  },
  strict: true,
  allowPositionals: false,
});

if (values.aide) {
  process.stdout.write(
    [
      "run-banc.mjs — banc hors ligne de la Salle OMO (L21)",
      "  --a-blanc            affiche les commandes, vérifie les refus, ne lance aucun Docker",
      "  --id <id>            identifiant du banc (défaut : local) ; le projet vaut sal11-omo-banc-<id>",
      "  --image <ref>        image de la salle (défaut : sal11-omo/opencode-omo:sal11)",
      "  --image-app <ref>    image du cockpit employée par les pilotes (défaut : sal11-omo/app:sal11)",
      "  --scenarios <liste>  g1,g2,g9,g12,g14,sul (défaut : tous)",
          "  --duree-g1-min <n>   durée des scénarios scriptés de G1, en minutes (défaut : 30)",
      "  --image-base <ref>   image opencode de base, épinglée par empreinte : G14 rejoue alors -SelfTest",
      "  --contournement      ajoute le tmpfs du contournement (défaut fautif reproduit par G2) pour laisser les mesures se faire",
      "  --sans-git           projets préparés sans dépôt git : banc DÉGRADÉ, seul moyen de mesurer le reste sur un hôte Windows",
      "  --ecrire-fixtures    REMPLACE les fixtures du dépôt (app/server/test-support/fixtures/omo-banc-*.jsonl) avec les",
      "                       captures du scénario « mes » ; sans cette option, elles vont dans la sortie du banc et le dépôt",
      "                       n'est jamais touché",
      "  --base <dossier>     dossier du banc, hors du dépôt (défaut : %TEMP%/sal11-omo-banc)",
      "  --garder             ne nettoie pas à la fin (diagnostic ; le verrou est rendu)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const ID = values.id ?? "local";
const IMAGE = values.image ?? `sal11-omo/opencode-omo:${ETIQUETTE_BANC}`;
const IMAGE_APP = values["image-app"] ?? `sal11-omo/app:${ETIQUETTE_BANC}`;
const DUREE_G1_MIN = /^\d{1,3}$/.test(values["duree-g1-min"] ?? "") ? Number(values["duree-g1-min"]) : 30;
const BASE = values.base ?? path.join(os.tmpdir(), "sal11-omo-banc");
const IMAGE_BASE = values["image-base"] ?? "";

/** Ports du banc : jamais 7777, jamais un port du produit. */
const PORT_ESPION = 7791;
const PORT_PILOTE = 7793;
/** Réseau fermé du banc : un plan d'adressage à lui, pour que `extra_hosts` ait une adresse à citer. */
const SOUS_RESEAU = "10.79.11.0/24";
const IP_COPILOT = "10.79.11.11";

const COMPOSE_PRODUIT = path.join(RACINE, "docker-compose.yml");
const COMPOSE_PROJETS = path.join(RACINE, "docker-compose.omo-projets.yml");
const COMPOSE_BANC = path.join(BANC, "banc.compose.yml");
const COMPOSE_CONTOURNEMENT = path.join(BANC, "banc-contournement.compose.yml");

const horodatage = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const barre = (p) => String(p).replace(/\\/g, "/");

const ecrire = (chemin, texte, mode = 0o644) => {
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  fs.writeFileSync(chemin, texte, { mode });
};

/** Journal du banc : à l'écran et dans `banc.log`, jamais le mot de passe (il ne traverse jamais cette fonction). */
let fichierJournal = null;
const dire = (texte) => {
  const ligne = `${new Date().toISOString()} ${texte}\n`;
  process.stdout.write(ligne);
  if (fichierJournal) {
    try {
      fs.appendFileSync(fichierJournal, ligne);
    } catch {
      /* le journal n'arrête pas le banc */
    }
  }
};

// --- Mode « à blanc » : ce que le banc ferait, et ce qu'il refuse ------------------------------------------------------------

function aBlanc() {
  const projet = nomDeProjet(ID);
  // Le mode à blanc n'écrit RIEN, nulle part : son compte rendu ne va qu'à l'écran.
  const dit = (t) => process.stdout.write(`${t}\n`);
  dit("[à blanc] aucune commande Docker n'est lancée, rien n'est écrit hors de ce compte rendu.");
  dit(`[à blanc] projet Compose : ${projet}`);
  dit(`[à blanc] images : ${IMAGE} (salle), ${IMAGE_APP} (pilotes)`);
  dit(`[à blanc] ports publiés sur la boucle locale : ${PORT_ESPION} (espion), ${PORT_PILOTE} (pilotage du faux) ; jamais 7777`);
  dit(`[à blanc] réseau fermé : ${SOUS_RESEAU}, faux Copilot à ${IP_COPILOT}, noms détournés : ${NOMS_COPILOT.join(", ")}`);
  dit(`[à blanc] portes : ${SCENARIOS.map((s) => s.id).join(", ")}`);
  dit(`[à blanc] projets préparés : ${values["sans-git"] ? "SANS dépôt git (banc dégradé)" : "avec de vrais dépôts git"}`);

  dit("");
  dit("[à blanc] commandes principales :");
  const composeArgs = ["compose", "--project-name", projet, "--env-file", "<banc.env>", "--file", barre(COMPOSE_PRODUIT), "--file", barre(COMPOSE_PROJETS), "--file", barre(COMPOSE_BANC), "--profile", "omo"];
  for (const suite of [
    ["config", "--quiet"],
    ["up", "--detach", "--wait", "omo-init", "banc-amorce", "banc-auth", "egress", "banc-copilot", "banc-espion", "banc-battement", "banc-precheck", "opencode-omo"],
    ["ps", "--all"],
    ["stop", "banc-battement"],
    ["down", "--volumes", "--remove-orphans"],
  ]) {
    dit(`  docker ${[...composeArgs, ...suite].join(" ")}`);
  }
  dit(`  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${barre(path.join(RACINE, "install.ps1"))} -OmoProjetsSeulement -WorkspacePath <projets jetables>`);
  dit(`  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true -v <certs>:/certs-out --entrypoint sh ${IMAGE_APP} -c "openssl …"`);

  dit("");
  dit("[à blanc] refus vérifiés :");
  const refus = [];
  const essayer = (quoi, action) => {
    try {
      action();
      refus.push({ quoi, refuse: false });
      dit(`  ✗ ${quoi} : ACCEPTÉ — c'est un défaut`);
    } catch (err) {
      const ok = err instanceof BancRefus;
      refus.push({ quoi, refuse: ok, message: String(err?.message ?? err).slice(0, 160) });
      dit(`  ${ok ? "✓" : "✗"} ${quoi} : ${String(err?.message ?? err).slice(0, 120)}`);
    }
  };
  essayer("projet « opencode-cockpit »", () => verifierProjet("opencode-cockpit"));
  essayer("projet « opencode-cockpit-e2e »", () => verifierProjet("opencode-cockpit-e2e"));
  essayer("projet « cockpit-e2e »", () => verifierProjet("cockpit-e2e"));
  essayer("projet « ocauto-1 »", () => verifierProjet("ocauto-1"));
  essayer("projet « omo11-omo-banc-x »", () => verifierProjet("omo11-omo-banc-x"));
  essayer("projet « eq11-e2e »", () => verifierProjet("eq11-e2e"));
  essayer("identifiant « ../evasion »", () => nomDeProjet("../evasion"));
  essayer("identifiant vide", () => nomDeProjet(""));

  dit("");
  dit("[à blanc] fichiers attendus :");
  const fichiers = [COMPOSE_PRODUIT, COMPOSE_BANC, path.join(BANC, "lib", "faux-copilot.mjs"), path.join(RACINE, "install.ps1"), path.join(RACINE, "docker", "opencode-omo", "omo-manifest.sha256")];
  let manquants = 0;
  for (const f of fichiers) {
    const la = fs.existsSync(f);
    if (!la) manquants += 1;
    dit(`  ${la ? "✓" : "✗"} ${barre(path.relative(RACINE, f))}`);
  }
  dit(`  (la surcharge ${barre(path.relative(RACINE, COMPOSE_PROJETS))} est écrite par install.ps1 au démarrage du banc)`);

  dit("");
  const refuses = refus.filter((r) => r.refuse).length;
  dit(`[à blanc] ${refuses}/${refus.length} refus vérifiés, ${fichiers.length - manquants}/${fichiers.length} fichiers présents.`);
  const ok = refuses === refus.length && manquants === 0;
  dit(`[à blanc] ${ok ? "VERT" : "ROUGE"}`);
  return ok ? 0 : 1;
}

// --- Banc réel ----------------------------------------------------------------------------------------------------------------

async function principal() {
  const projet = nomDeProjet(ID);
  const rendreVerrou = prendreVerrou(projet);
  const dossier = path.join(BASE, `${projet}-${horodatage()}`);
  const chemins = {
    dossier,
    sortie: path.join(dossier, "sortie"),
    certs: path.join(dossier, "certs"),
    certsPrive: path.join(dossier, "certs-prive"),
    source: path.join(dossier, "source"),
    ws: path.join(dossier, "ws"),
    env: path.join(dossier, "banc.env"),
    journal: path.join(dossier, "banc.log"),
  };
  for (const d of [chemins.sortie, chemins.certs, chemins.certsPrive, chemins.source, chemins.ws]) fs.mkdirSync(d, { recursive: true });
  fichierJournal = chemins.journal;

  const fichiersCompose = [COMPOSE_PRODUIT, COMPOSE_PROJETS, COMPOSE_BANC];
  if (values.contournement) fichiersCompose.push(COMPOSE_CONTOURNEMENT);
  const bilan = { projet, image: IMAGE, debut: Date.now(), portes: [], mesures: {}, nettoyage: null };
  let demarre = false;

  try {
    dire(`banc ${projet} — dossier ${dossier}`);
    const pileAvant = await pileUtilisateur();
    ecrire(path.join(chemins.sortie, "pile-utilisateur-avant.txt"), `${pileAvant.join("\n")}\n`);
    dire(`pile de l'utilisateur relevée : ${pileAvant.length} ligne(s) opencode-cockpit-* / ocauto-*`);

    await dockerOuEchec(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    await dockerOuEchec(["image", "inspect", "--format", "{{.Id}}", IMAGE_APP]);

    dire("certificats du banc (conteneur jetable, sans réseau)");
    const releve = await fabriquerCertificats(chemins.certs, IMAGE_APP);
    ecrire(path.join(chemins.sortie, "certs.txt"), `${releve}\n`);
    for (const nom of ["serveur.pem", "serveur.key"]) {
      fs.renameSync(path.join(chemins.certs, nom), path.join(chemins.certsPrive, nom));
    }
    dire("autorité de banc dans certs/, certificat et clé du faux dans certs-prive/ (la salle ne voit jamais la clé)");

    dire(
      values["sans-git"]
        ? "projets jetables SANS dépôt git (banc dégradé, --sans-git) et liste des projets préparés (install.ps1 -OmoProjetsSeulement)"
        : "projets jetables (vrais dépôts git) et liste des projets préparés (install.ps1 -OmoProjetsSeulement)",
    );
    await preparerProjets(chemins.ws, { avecGit: !values["sans-git"] });
    const installe = await lancer(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(RACINE, "install.ps1"), "-OmoProjetsSeulement", "-WorkspacePath", chemins.ws],
      { cwd: RACINE, delaiMs: 180_000 },
    );
    ecrire(path.join(chemins.sortie, "install-projets.log"), `${installe.sortie}\n${installe.erreur}\n`);
    if (installe.code !== 0) throw new Error(`install.ps1 -OmoProjetsSeulement a échoué (code ${installe.code}) : voir install-projets.log`);
    if (!fs.existsSync(COMPOSE_PROJETS)) throw new Error("install.ps1 n'a pas écrit docker-compose.omo-projets.yml");
    fs.copyFileSync(path.join(RACINE, "omo-projets.json"), path.join(chemins.source, "omo-projets.json"));
    dire("surcharge des projets écrite et recopiée dans source/");

    // Mot de passe de la salle : tiré ici, écrit dans le fichier d'environnement en 0600, jamais affiché ni journalisé.
    const motDePasse = randomBytes(24).toString("base64url");
    const jetonPilote = randomBytes(24).toString("base64url");
    ecrire(chemins.env, fichierEnv({ chemins, motDePasse, jetonPilote }), 0o600);
    dire(`fichier d'environnement écrit en 0600 (mot de passe tiré au hasard, jamais affiché)`);

    const compose = (args, options = {}) => {
      verifierProjet(projet);
      const base = ["compose", "--project-name", projet, "--env-file", chemins.env];
      for (const f of fichiersCompose) base.push("--file", f);
      base.push("--profile", "omo");
      return docker([...base, ...args], { cwd: RACINE, delaiMs: options.delaiMs ?? 600_000, silencieux: options.silencieux !== false });
    };

    const verif = await compose(["config", "--quiet"]);
    if (verif.code !== 0) throw new Error(`docker compose config refusé :\n${String(verif.erreur).slice(-1200)}`);
    dire("les trois fichiers compose se composent sans erreur");

    dire("démarrage de la salle (profil omo) — aucun cockpit, aucun port 7777");
    demarre = true;
    const monte = await compose(["up", "--detach", "--wait", "--wait-timeout", "240", "omo-init", "banc-amorce", "banc-auth", "egress", "banc-copilot", "banc-espion", "banc-battement", "banc-precheck", "opencode-omo"], { delaiMs: 420_000 });
    ecrire(path.join(chemins.sortie, "compose-up.log"), `${monte.sortie}\n${monte.erreur}\n`);
    if (monte.code !== 0) {
      // `--wait` échoue aussi quand un service jetable a fini : on ne renonce que si `opencode-omo` n'est pas là.
      dire(`compose up --wait a rendu ${monte.code} : on vérifie l'état réel de la salle`);
    }

    const ctx = await construireContexte({ projet, chemins, compose, motDePasse, jetonPilote, bilan });
    const pret = await jusqua(async () => (await ctx.etat())?.phase === "opencode-lance", { delaiMs: 240_000, pasMs: 1000 });
    if (!pret) {
      const etat = await ctx.etat();
      dire(`la salle n'a pas atteint « opencode-lance » (état : ${etat ? etat.phase : "illisible"})`);
      ecrire(path.join(chemins.sortie, "opencode-omo.log"), await ctx.logs("opencode-omo"));
      // Un démarrage qui n'aboutit pas ne dit rien de lui-même dans le journal : le superviseur publie SON constat dans
      // `state.json` (projets préparés, balayage du dossier de travail, dossiers de configuration). On le garde tel quel, avec
      // la table des montages du conteneur, sans quoi l'analyse d'après coup en est réduite aux suppositions.
      ecrire(path.join(chemins.sortie, "demarrage-etat.json"), `${JSON.stringify(etat, null, 2)}\n`);
      const montages = await ctx.exec("opencode-omo", ["sh", "-c", "cat /proc/self/mountinfo"], { root: true, delaiMs: 60_000 }).catch(() => null);
      ecrire(path.join(chemins.sortie, "demarrage-montages.txt"), `${montages?.sortie ?? "(table des montages illisible)"}\n`);
      const git = await ctx
        .exec("opencode-omo", ["sh", "-c", "ls -la /workspace /workspace/*/ 2>&1 | head -60; echo ---; ls -la /workspace/*/.git 2>&1 | head -20"], { delaiMs: 60_000 })
        .catch(() => null);
      ecrire(path.join(chemins.sortie, "demarrage-workspace.txt"), `${git?.sortie ?? "(dossier de travail illisible)"}\n`);
      const raison = etat?.workspaceGit ?? null;
      dire(
        `constat du superviseur : projets=${JSON.stringify(etat?.projets ?? null)} ; balayage=${JSON.stringify(raison)}`.slice(0, 600),
      );
    } else {
      dire("salle prête : opencode lancé par le superviseur");
      // `state.json` dit « opencode-lance » dès que le processus est parti ; la première requête portant un `directory`
      // déclenche encore l'ouverture de l'instance, qui prend de quelques secondes à une minute. Les portes attendent ici,
      // une fois pour toutes, plutôt que de se heurter chacune à un délai d'attente.
      const debutOuverture = Date.now();
      const servante = await jusqua(
        async () => {
          const r = await ctx.client.get(`/agent?directory=${encodeURIComponent("/workspace/projet-ouvert")}`, { delaiMs: 30_000 }).catch(() => null);
          return r !== null && r.code === 200 && Array.isArray(r.json) && r.json.length > 0;
        },
        { delaiMs: 300_000, pasMs: 2000 },
      );
      bilan.ouvertureProjetMs = Date.now() - debutOuverture;
      dire(servante ? `projet ouvert, instance servante (${Math.round(bilan.ouvertureProjetMs / 1000)} s)` : "l'instance ne sert toujours pas : les portes le diront");
    }

    const demandes = (values.scenarios ?? "").trim();
    const choisis = demandes === "" ? SCENARIOS : SCENARIOS.filter((s) => demandes.split(",").map((x) => x.trim()).includes(s.id));
    if (choisis.length === 0) throw new Error(`--scenarios : aucun scénario connu dans « ${demandes} » (connus : ${SCENARIOS.map((s) => s.id).join(", ")})`);

    for (const scenario of choisis) {
      dire(`--- porte ${scenario.id} : ${scenario.titre}`);
      const debut = Date.now();
      let resultat;
      try {
        resultat = await scenario.executer(ctx);
      } catch (err) {
        resultat = { ok: false, points: [{ nom: "exécution", ok: false, detail: String(err?.stack ?? err).slice(0, 1200) }] };
      }
      // « Sans objet » : la porte n'avait rien à observer dans cette configuration de banc (par exemple `git` en `--sans-git`).
      // Elle ne compte ni pour ni contre : un banc dégradé ne doit ni mentir en vert, ni se dire rouge pour une mesure absente.
      if (resultat.sansObjet) {
        bilan.portes.push({ id: scenario.id, titre: scenario.titre, sansObjet: String(resultat.sansObjet), dureeMs: Date.now() - debut, points: [] });
        dire(`--- porte ${scenario.id} : SANS OBJET — ${resultat.sansObjet}`);
        continue;
      }
      const points = resultat.points ?? [];
      const ok = resultat.ok !== false && points.every((p) => p.ok);
      bilan.portes.push({ id: scenario.id, titre: scenario.titre, ok, dureeMs: Date.now() - debut, points });
      if (resultat.mesures) Object.assign(bilan.mesures, resultat.mesures);
      for (const p of points) dire(`  ${p.ok ? "✓" : "✗"} ${p.nom}${p.detail ? ` — ${String(p.detail).slice(0, 300)}` : ""}`);
      dire(`--- porte ${scenario.id} : ${ok ? "VERTE" : "ROUGE"} (${Math.round((Date.now() - debut) / 1000)} s)`);
    }
  } catch (err) {
    dire(`ARRÊT : ${String(err?.stack ?? err).slice(0, 2000)}`);
    bilan.arret = String(err?.message ?? err).slice(0, 400);
  } finally {
    if (demarre && !values.garder) {
      dire("nettoyage du projet du banc (et de lui seul)");
      try {
        const r = await nettoyerProjet(projet, fichiersCompose, chemins.env);
        ecrire(path.join(chemins.sortie, "compose-down.log"), `${r.sortie}\n${r.erreur}\n`);
      } catch (err) {
        dire(`nettoyage en erreur : ${String(err?.message ?? err).slice(0, 300)}`);
      }
      try {
        bilan.nettoyage = await restes(projet);
        const total = bilan.nettoyage.conteneurs.length + bilan.nettoyage.volumes.length + bilan.nettoyage.reseaux.length;
        dire(`restes ${projet}-* : ${total}`);
      } catch (err) {
        dire(`relevé des restes en erreur : ${String(err?.message ?? err).slice(0, 200)}`);
      }
    } else if (values.garder) {
      dire(`--garder : le projet ${projet} reste en place. À retirer à la main, avec le même --env-file.`);
    }
    try {
      const pileApres = await pileUtilisateur();
      ecrire(path.join(chemins.sortie, "pile-utilisateur-apres.txt"), `${pileApres.join("\n")}\n`);
      const avant = fs.readFileSync(path.join(chemins.sortie, "pile-utilisateur-avant.txt"), "utf8");
      bilan.pileUtilisateurIdentique = avant === `${pileApres.join("\n")}\n`;
      dire(`pile de l'utilisateur identique avant et après : ${bilan.pileUtilisateurIdentique ? "oui" : "NON"}`);
    } catch {
      bilan.pileUtilisateurIdentique = null;
    }
    // Le mot de passe ne survit pas au banc : le fichier d'environnement part, même en échec.
    try {
      if (!values.garder) fs.rmSync(chemins.env, { force: true });
    } catch {
      /* rien */
    }
    rendreVerrou();
    bilan.fin = Date.now();
    const jugees = bilan.portes.filter((p) => !p.sansObjet);
    const horsJeu = bilan.portes.length - jugees.length;
    bilan.vert = jugees.length > 0 && jugees.every((p) => p.ok) && !bilan.arret;
    ecrire(path.join(chemins.sortie, "bilan.json"), `${JSON.stringify(bilan, null, 2)}\n`);
    const mention = horsJeu > 0 ? ` (${horsJeu} sans objet)` : "";
    dire(`bilan : ${jugees.filter((p) => p.ok).length}/${jugees.length} portes vertes${mention} — ${bilan.vert ? "VERT" : "ROUGE"}`);
    dire(`sorties : ${chemins.sortie}`);
  }
  return bilan.vert ? 0 : 1;
}

/**
 * Deux projets jetables : un projet ouvert par le banc, un second préparé mais jamais ouvert (M31).
 *
 * Par défaut ce sont de VRAIS dépôts git, avec un commit et une modification non commitée : sans `.git`, `install.ps1`
 * n'aurait rien à monter en lecture seule, et la mesure M23 (`git status` et `git diff` avec `.git:ro`) n'observerait rien.
 * C'est aussi le cas RÉEL d'un poste : un dossier de travail sans aucun dépôt n'existe guère.
 *
 * `--sans-git` retire les dépôts. Ce n'est pas une commodité : sur un hôte Windows, un `.git` protégé ferme la salle (porte
 * G2, scénario `git`), et c'est la seule façon d'aller mesurer tout le reste sur ce PC. Le banc le dit alors à chaque
 * exécution, pour que personne ne prenne un banc dégradé pour un banc complet.
 *
 * L'identité git est locale au dépôt et factice : rien de la machine n'entre dans ces projets.
 */
async function preparerProjets(ws, { avecGit = true } = {}) {
  for (const [nom, contenu] of [
    ["projet-ouvert", "Projet du banc, ouvert par la salle.\n"],
    ["projet-temoin", "Projet préparé, jamais ouvert : témoin de la mesure M31.\n"],
  ]) {
    const racine = path.join(ws, nom);
    fs.mkdirSync(racine, { recursive: true });
    fs.writeFileSync(path.join(racine, "LISEZMOI.md"), contenu);
    fs.writeFileSync(path.join(racine, "notes.txt"), `Fichier témoin de ${nom}.\n`);
    if (!avecGit) continue;
    const git = (args) => lancer("git", ["-C", racine, ...args], { delaiMs: 60_000 });
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Banc de la salle"]);
    await git(["config", "user.email", "banc@exemple.invalid"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["add", "-A"]);
    await git(["commit", "-m", "Projet jetable du banc"]);
    // Une modification laissée en travail : `git status` et `git diff` ont alors quelque chose à dire (M23).
    fs.appendFileSync(path.join(racine, "notes.txt"), "Ligne ajoutée après le commit, pour que git diff ne soit pas vide.\n");
  }
}

function fichierEnv({ chemins, motDePasse, jetonPilote }) {
  // Une valeur par ligne, sans guillemets : Compose lit ce fichier tel quel. Le mot de passe n'apparaît nulle part ailleurs.
  return `${[
    "# Fichier d'environnement du banc L21. Généré à chaque exécution, en 0600, supprimé à la fin. Ne jamais copier ailleurs.",
    `COMPOSE_PROJECT_NAME=${PREFIXE_PROJET}${ID}`,
    `WORKSPACE_DIR=${barre(chemins.ws)}`,
    `COCKPIT_OMO_IMAGE=${IMAGE}`,
    `COCKPIT_APP_IMAGE=${IMAGE_APP}`,
    `COCKPIT_OPENCODE_IMAGE=${IMAGE_APP}`,
    `OPENCODE_OMO_PASSWORD=${motDePasse}`,
    `OPENCODE_SERVER_PASSWORD=${motDePasse}`,
    `COCKPIT_TOKEN=${randomBytes(24).toString("base64url")}`,
    "COCKPIT_COPILOT_API_URL=https://api.githubcopilot.com",
    "COCKPIT_GITHUB_ENTERPRISE_DOMAIN=",
    "NODE_EXTRA_CA_CERTS=/certs/ca.pem",
    "HTTP_PROXY=",
    "HTTPS_PROXY=",
    "NO_PROXY=",
    "COCKPIT_PORT=7791",
    `BANC_LIB=${barre(path.join(BANC, "lib"))}`,
    `BANC_OUT=${barre(chemins.sortie)}`,
    `BANC_CERTS=${barre(chemins.certs)}`,
    `BANC_CERTS_PRIVE=${barre(chemins.certsPrive)}`,
    `BANC_SOURCE=${barre(chemins.source)}`,
    `BANC_PORT_ESPION=${PORT_ESPION}`,
    `BANC_PORT_PILOTE=${PORT_PILOTE}`,
    `BANC_JETON_PILOTE=${jetonPilote}`,
    `BANC_IP_COPILOT=${IP_COPILOT}`,
    `BANC_SUBNET=${SOUS_RESEAU}`,
    "TZ=Europe/Paris",
  ].join("\n")}\n`;
}

async function construireContexte({ projet, chemins, compose, motDePasse, jetonPilote, bilan }) {
  const client = clientOmo({ port: PORT_ESPION, utilisateur: "opencode", motDePasse });
  const faux = piloteFaux({ port: PORT_PILOTE, jeton: jetonPilote });

  /** Lecture d'un fichier d'un volume du banc, par un conteneur jetable sans réseau. */
  const lireVolume = async (volume, fichier) => {
    const r = await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--volume",
      `${projet}_${volume}:/lu:ro`,
      "--entrypoint",
      "cat",
      IMAGE_APP,
      `/lu/${fichier}`,
    ]);
    return r.code === 0 ? String(r.sortie) : null;
  };

  const ctx = {
    projet,
    chemins,
    image: IMAGE,
    imageApp: IMAGE_APP,
    hoteCopilot: "api.githubcopilot.com",
    nomsCopilot: NOMS_COPILOT,
    ipCopilot: IP_COPILOT,
    portEspion: PORT_ESPION,
    portPilote: PORT_PILOTE,
    dureeG1Min: DUREE_G1_MIN,
    contournement: Boolean(values.contournement),
    sansGit: Boolean(values["sans-git"]),
    // Faux par défaut : le scénario « mes » écrit ses captures dans la sortie du banc, jamais dans le dépôt (cheminDeFixture).
    ecrireFixtures: Boolean(values["ecrire-fixtures"]),
    baseImage: IMAGE_BASE,
    lancer,
    racine: RACINE,
    banc: BANC,
    client,
    faux,
    requete,
    compose,
    docker,
    attendre,
    jusqua,
    dire,
    bilan,
    lireVolume,
    /**
     * Commande dans un service du banc, **en tant que `node`** par défaut (uid 1000). C'est l'utilisateur qui compte : le
     * conteneur de la salle démarre root pour son superviseur, et une sonde lancée sans `--user` écrirait donc là où `node`
     * ne peut pas, ce qui rendrait vert un contrôle faux. `root: true` pour les rares constats qui demandent root.
     */
    exec: async (service, argv, { root = false, delaiMs = 120_000 } = {}) => {
      const args = ["exec", "-T", "--user", root ? "0:0" : "1000:1000"];
      return compose([...args, service, ...argv], { delaiMs, silencieux: true });
    },
    logs: async (service, { lignes = 2000 } = {}) => {
      const r = await compose(["logs", "--no-color", "--tail", String(lignes), service], { silencieux: true });
      return `${r.sortie}\n${r.erreur}`;
    },
    etat: async () => {
      const texte = await lireVolume("omo-state", "state.json");
      if (texte === null) return null;
      try {
        return JSON.parse(texte);
      } catch {
        return null;
      }
    },
    sortie: (nom) => {
      const chemin = path.join(chemins.sortie, nom);
      return fs.existsSync(chemin) ? fs.readFileSync(chemin, "utf8") : null;
    },
    lignesSortie: (nom) =>
      (ctx.sortie(nom) ?? "")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((x) => x !== null),
    ecrireSortie: (nom, texte) => ecrire(path.join(chemins.sortie, nom), texte),
  };
  return ctx;
}

// --- Entrée ---------------------------------------------------------------------------------------------------------------------

try {
  const code = values["a-blanc"] ? aBlanc() : await principal();
  process.exit(code);
} catch (err) {
  process.stderr.write(`ARRÊT : ${String(err?.message ?? err).slice(0, 800)}\n`);
  process.exit(1);
}
