// Banc de la Salle OMO : monte la salle réelle, hors ligne, devant un faux Copilot, et joue les portes. Deux modes :
// - HORS LIGNE (L21, défaut) : trois pilotes tiennent la place du cockpit pour le battement, l'authentification et le
//   pré-contrôle, et rien d'autre ;
// - COMPLET (L21b, `--complet`) : le cockpit RÉEL, bâti depuis une copie `git archive` avec `SALLE_OUVERTE` basculée dans la
//   copie seulement, devant une instance principale réelle sur un faux fournisseur, sur un réseau fermé (cockpit/).
//
//   node e2e/omo-banc/run-banc.mjs --a-blanc           commandes affichées, refus vérifiés, aucun Docker
//   node e2e/omo-banc/run-banc.mjs --id l21            banc hors ligne réel, projet sal11-omo-banc-l21
//   node e2e/omo-banc/run-banc.mjs --id l21 --scenarios g2,g9
//   node e2e/omo-banc/run-banc.mjs --id fumee --complet --battement-banc
//
// Ce que le banc est, et n'est pas :
// - il lance l'IMAGE réelle de la salle (opencode 1.18.30 + Oh My OpenAgent 4.19.4), avec le compose du produit, la surcharge
//   des projets d'`install.ps1 -OmoProjetsSeulement` et sa propre surcharge ; rien du produit n'est modifié pour lui ;
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
import { pathToFileURL } from "node:url";
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

import { constantesM22, FICHIER_CONSTANTES_M22, jugerLienM22 } from "./lib/lien-m22.mjs";

import cockpitFumee from "./cockpit/fumee.mjs";
import { activationLivreeDansCopie, basculerSalleOuverte, FICHIER_SALLE_OUVERTE, preparerCockpit, refAcceptee } from "./cockpit/preparer.mjs";
import g1 from "./scenarios/g1-reseau.mjs";
import g2 from "./scenarios/g2-chargement.mjs";
import g9 from "./scenarios/g9-pilote.mjs";
import g12 from "./scenarios/g12-agents.mjs";
import g14 from "./scenarios/g14-configuration.mjs";
import git from "./scenarios/git-protection.mjs";
import hooks from "./scenarios/hooks-gardes.mjs";
import mes from "./scenarios/mesures.mjs";
import sup from "./scenarios/sources-supprimees.mjs";
import sul from "./scenarios/sul-sous-chaines.mjs";

// L'ordre compte : `git` sonde le dossier de travail avant que quoi que ce soit ne l'ouvre, G9 coupe la salle et la remet en
// marche, les mesures veulent une salle vivante, `hooks` provoque les automatismes gardés (M28), G14 et SUL n'en ont pas
// besoin. `sup` (relecture 2ter-vague-3) supprime des entrées du projet jetable et laisse la salle arrêtée : toujours en
// dernier. Le banc HORS LIGNE (pilotes) joue ceux-là. Le banc COMPLET (`--complet`, cockpit réel) joue `cockpit-fumee`, puis
// les portes posées dans `portes/` (L27a, L27b), chargées d'elles-mêmes par `chargerPortes` : un fichier de porte n'a pas à
// toucher ce lanceur.
const SCENARIOS = [git, g1, g2, g12, g9, mes, hooks, g14, sul, sup];

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const BANC = import.meta.dirname;
const PORTES = path.join(BANC, "portes");
/** Projets de test livrés avec le banc (`projets/`), recopiés dans le dossier de travail jetable sur `--projets-test`. */
const PROJETS_TEST = path.join(BANC, "projets");
const NOMS_PROJETS_TEST = Object.freeze(["g7", "g13"]);

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
    complet: { type: "boolean" },
    ref: { type: "string" },
    "image-cockpit": { type: "string" },
    "battement-banc": { type: "boolean" },
    "projets-test": { type: "string" },
    aide: { type: "boolean" },
  },
  strict: true,
  allowPositionals: false,
});

if (values.aide) {
  process.stdout.write(
    [
      "run-banc.mjs — banc de la Salle OMO (L21 hors ligne, L21b complet)",
      "  --a-blanc            affiche les commandes, vérifie les refus, ne lance aucun Docker",
      "  --id <id>            identifiant du banc (défaut : local) ; le projet vaut sal11-omo-banc-<id>",
      "  --image <ref>        image de la salle (défaut : sal11-omo/opencode-omo:sal11)",
      "  --image-app <ref>    image du cockpit employée par les pilotes et les services du banc (défaut : sal11-omo/app:sal11)",
      "  --scenarios <liste>  hors ligne : git,g1,g2,g12,g9,mes,hooks,g14,sul,sup ; complet : cockpit-fumee (défaut : tous du mode)",
          "  --duree-g1-min <n>   durée des scénarios scriptés de G1, en minutes (défaut : 30)",
      "  --image-base <ref>   image opencode de base, épinglée par empreinte : G14 rejoue alors -SelfTest",
      "  --contournement      ajoute le tmpfs du contournement (défaut fautif reproduit par G2) pour laisser les mesures se faire",
      "  --sans-git           projets préparés sans dépôt git : banc DÉGRADÉ (porte git sans objet, M23 non mesurable) ; il",
      "                       ne remplace JAMAIS une exécution avec de vrais dépôts",
      "  --complet            banc COMPLET : cockpit RÉEL jetable (image bâtie par cockpit/preparer.mjs depuis une copie git",
      "                       archive, SALLE_OUVERTE basculée dans la copie seulement) au lieu des pilotes, réseau fermé ;",
      "                       joue cockpit-fumee puis les portes de portes/ (L27a, L27b)",
      "  --ref <commit>       commit d'où bâtir le cockpit réel (--complet ; défaut : HEAD ; branche, étiquette ou SHA)",
      "  --image-cockpit <r>  image du cockpit réel déjà bâtie (--complet ; par défaut, le banc la bâtit)",
      "  --battement-banc     (--complet) les pilotes du banc déposent la liste des projets et écrivent le battement, pour une",
      "                       tête antérieure au train de la vague 4 (startHeartbeat() jamais appelé) : le banc le dit dans son bilan",
      "  --projets-test <l>   recopie des projets de test du banc (g7, g13) comme projets préparés (portes G7 et G13) ;",
      "                       g7 est PIÉGÉ : le pré-contrôle réel refuse alors le démarrage (portée « prepares »)",
      "  --ecrire-fixtures    REMPLACE les fixtures du dépôt (app/server/test-support/fixtures/omo-banc-*.jsonl) avec les",
      "                       captures du scénario « mes » ; sans cette option, elles vont dans la sortie du banc et le dépôt",
      "                       n'est jamais touché",
      "  --base <dossier>     dossier du banc, hors du dépôt (défaut : %TEMP%/sal11-omo-banc)",
      "  --garder             ne nettoie pas à la fin (diagnostic ; le verrou est rendu)",
      "",
      "DEUX EXÉCUTIONS SONT OBLIGATOIRES pour tout couvrir (README §2.1) :",
      "  1. le banc HORS LIGNE avec de vrais dépôts (défaut, sans --sans-git) : git, g1, g2, g12, g9, mes, hooks, g14, sul, sup ;",
      "  2. le banc COMPLET (--complet) : le cockpit réel et ses portes, qui ne se jouent pas devant des pilotes.",
      "  Avant L16c, c'était « vrais dépôts » puis « --sans-git » (la salle ne démarrait pas avec un dépôt) : ce n'est plus vrai,",
      "  une seule exécution hors ligne avec de vrais dépôts mesure la porte git ET le reste. --sans-git ne sert qu'au diagnostic.",
      "",
      "LANCEMENT DÉTACHÉ OBLIGATOIRE pour une exécution longue (README §2.2) : lancé depuis un shell d'arrière-plan (celui d'un",
      "harnais, d'un éditeur…), le banc est tué peu après la première passe de G1 — journal figé, pile debout, verrou gardé.",
      "Le lancer par Start-Process (PowerShell), sortie redirigée vers un fichier, puis sonder ce fichier et bilan.json.",
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
const COMPLET = Boolean(values.complet);
const REF = values.ref ?? "HEAD";
/** Image du cockpit réel : donnée par --image-cockpit, sinon bâtie par le banc dans le mode complet. */
const IMAGE_COCKPIT = values["image-cockpit"] ?? `sal11-omo/cockpit-reel:${ETIQUETTE_BANC}`;
const BATTEMENT_BANC = Boolean(values["battement-banc"]);
/** Projets de test demandés : noms connus seulement (un nom inconnu arrête le banc avant tout Docker). */
const DEMANDES_PROJETS_TEST = (values["projets-test"] ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x !== "");

/** Ports du banc : jamais 7777, jamais un port du produit. */
const PORT_ESPION = 7791;
const PORT_PILOTE = 7793;
const PORT_COCKPIT = 7795;
const PORT_FOURNISSEUR = 7797;
/** Réseau fermé du banc : un plan d'adressage à lui, pour que `extra_hosts` ait une adresse à citer. */
const SOUS_RESEAU = "10.79.11.0/24";
const IP_COPILOT = "10.79.11.11";

const COMPOSE_PRODUIT = path.join(RACINE, "docker-compose.yml");
const COMPOSE_PROJETS = path.join(RACINE, "docker-compose.omo-projets.yml");
const COMPOSE_BANC = path.join(BANC, "banc.compose.yml");
const COMPOSE_COCKPIT = path.join(BANC, "cockpit", "cockpit.compose.yml");
/** Fichiers e2e réutilisés par le mode complet (faux fournisseur et config de l'instance principale, L7a) : jamais modifiés. */
const LIB_E2E = path.join(RACINE, "e2e", "lib");
const COCKPIT_LIB = path.join(BANC, "cockpit");
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

/**
 * Portes du banc complet posées dans `portes/` (L27a, L27b, vague 5) : chaque `*.mjs` exporte par défaut `{ id, titre, executer }`,
 * comme les scénarios du banc. Chargées dans l'ordre des noms ; une forme fausse ou un identifiant en double arrête le banc
 * AVANT tout Docker, au lieu de jouer une porte à moitié. Dossier absent : aucune porte.
 */
async function chargerPortes(dossier = PORTES) {
  let noms;
  try {
    noms = fs
      .readdirSync(dossier)
      .filter((n) => n.endsWith(".mjs"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const portes = [];
  for (const nom of noms) {
    const porte = (await import(pathToFileURL(path.join(dossier, nom)).href)).default;
    if (porte === null || typeof porte !== "object" || typeof porte.id !== "string" || typeof porte.titre !== "string" || typeof porte.executer !== "function") {
      throw new Error(`portes/${nom} : un export par défaut { id, titre, executer } est attendu`);
    }
    portes.push(porte);
  }
  return portes;
}

async function scenariosDuMode() {
  const liste = COMPLET ? [cockpitFumee, ...(await chargerPortes())] : SCENARIOS;
  const ids = liste.map((s) => s.id);
  const double = ids.find((id, i) => ids.indexOf(id) !== i);
  if (double !== undefined) throw new Error(`deux scénarios portent l'identifiant « ${double} »`);
  return liste;
}

/** Vérifie les projets de test demandés : noms connus, dossier présent. Rend les noms, ou lève avant tout Docker. */
function projetsTestDemandes() {
  for (const nom of DEMANDES_PROJETS_TEST) {
    if (!NOMS_PROJETS_TEST.includes(nom)) throw new Error(`--projets-test : « ${nom.slice(0, 40)} » inconnu (connus : ${NOMS_PROJETS_TEST.join(", ")})`);
    if (!fs.existsSync(path.join(PROJETS_TEST, nom))) throw new Error(`--projets-test : dossier projets/${nom} absent`);
  }
  return [...new Set(DEMANDES_PROJETS_TEST)];
}

/**
 * Ce que la tête de CE dépôt livre au cockpit réel, lu dans la source (lecture seule) : la bascule possible de `SALLE_OUVERTE`
 * (une occurrence exactement), l'activation « omo » et le déclencheur du battement. Sert au mode à blanc.
 */
function livraisonDuDepot() {
  const texte = fs.readFileSync(path.join(RACINE, ...FICHIER_SALLE_OUVERTE.split("/")), "utf8");
  return { bascules: basculerSalleOuverte(texte).remplacements, ...activationLivreeDansCopie(RACINE) };
}

/** Fichier compose du mode : le cockpit réel remplace les pilotes en mode complet. */
function composeDuMode() {
  return COMPLET ? COMPOSE_COCKPIT : COMPOSE_BANC;
}

/** Services démarrés par `up` dans ce mode (le reste du compose reste créé à rien). */
function servicesDuMode() {
  if (!COMPLET) return ["omo-init", "banc-amorce", "banc-auth", "egress", "banc-copilot", "banc-espion", "banc-battement", "banc-precheck", "opencode-omo"];
  const services = ["omo-init", "cockpit-prepare", "faux-fournisseur", "opencode", "egress", "banc-copilot", "banc-espion", "opencode-omo", "cockpit"];
  // --battement-banc : les deux gestes de startHeartbeat() (liste des projets déposée, battement) faits par les pilotes du banc.
  if (BATTEMENT_BANC) services.push("banc-amorce", "banc-battement");
  return services;
}

async function aBlanc() {
  const projet = nomDeProjet(ID);
  // Le mode à blanc n'écrit RIEN, nulle part : son compte rendu ne va qu'à l'écran.
  const dit = (t) => process.stdout.write(`${t}\n`);
  dit("[à blanc] aucune commande Docker n'est lancée, rien n'est écrit hors de ce compte rendu.");
  dit(`[à blanc] mode : ${COMPLET ? "COMPLET (cockpit réel jetable)" : "hors ligne (pilotes)"}`);
  dit(`[à blanc] projet Compose : ${projet}`);
  if (COMPLET) {
    dit(`[à blanc] images : ${IMAGE} (salle), ${IMAGE_COCKPIT} (cockpit réel, bâti depuis ${REF}), ${IMAGE_APP} (services du banc)`);
    dit(`[à blanc] ports publiés sur la boucle locale : ${PORT_COCKPIT} (cockpit), ${PORT_ESPION} (espion), ${PORT_PILOTE} (faux Copilot), ${PORT_FOURNISSEUR} (faux fournisseur) ; jamais 7777`);
  } else {
    dit(`[à blanc] images : ${IMAGE} (salle), ${IMAGE_APP} (pilotes)`);
    dit(`[à blanc] ports publiés sur la boucle locale : ${PORT_ESPION} (espion), ${PORT_PILOTE} (pilotage du faux) ; jamais 7777`);
  }
  dit(`[à blanc] réseau fermé : ${SOUS_RESEAU}, faux Copilot à ${IP_COPILOT}, noms détournés : ${NOMS_COPILOT.join(", ")}`);
  dit(`[à blanc] portes : ${(await scenariosDuMode()).map((s) => s.id).join(", ")}`);
  dit(`[à blanc] projets préparés : ${values["sans-git"] ? "SANS dépôt git (banc dégradé)" : "avec de vrais dépôts git"}${DEMANDES_PROJETS_TEST.length > 0 ? `, plus les projets de test ${projetsTestDemandes().join(", ")}` : ""}`);
  if (COMPLET) {
    const livre = livraisonDuDepot();
    dit(`[à blanc] cette tête livre : bascule de SALLE_OUVERTE possible (${livre.bascules} occurrence(s), une exigée), activation « omo » ${livre.choixOmo ? "oui" : "NON (L22c)"}, battement déclenché par le cockpit ${livre.battementDeclenche ? "oui" : "NON (startHeartbeat() jamais appelé)"}`);
    dit(`[à blanc] battement : ${BATTEMENT_BANC ? "assuré par les pilotes du banc (--battement-banc), et dit dans le bilan" : "celui du cockpit seulement"}`);
  }

  dit("");
  dit("[à blanc] commandes principales :");
  if (COMPLET) dit(`  cockpit réel : git archive ${REF} → copie jetable → SALLE_OUVERTE=true → docker build -f app/Dockerfile -t ${IMAGE_COCKPIT} (npm ci, Internet, aucun appel Copilot)`);
  const composeArgs = ["compose", "--project-name", projet, "--env-file", "<banc.env>", "--file", barre(COMPOSE_PRODUIT), "--file", barre(COMPOSE_PROJETS), "--file", barre(composeDuMode()), "--profile", "omo"];
  const services = servicesDuMode();
  for (const suite of [
    ["config", "--quiet"],
    ["up", "--detach", "--wait", ...services],
    ["ps", "--all"],
    COMPLET ? ["logs", "--no-color", "cockpit"] : ["stop", "banc-battement"],
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
  if (COMPLET) {
    // La référence du cockpit réel part en argument de git : une option déguisée est refusée avant tout appel.
    essayer("référence « --output=/tmp/x » pour le cockpit réel", () => {
      if (!refAcceptee("--output=/tmp/x")) throw new BancRefus("référence refusée : branche, étiquette ou SHA attendus");
    });
  }

  dit("");
  dit("[à blanc] fichiers attendus :");
  const fichiers = [COMPOSE_PRODUIT, composeDuMode(), path.join(BANC, "lib", "faux-copilot.mjs"), path.join(RACINE, "install.ps1"), path.join(RACINE, "docker", "opencode-omo", "omo-manifest.sha256")];
  if (COMPLET) {
    fichiers.push(
      path.join(COCKPIT_LIB, "preparer.mjs"),
      path.join(COCKPIT_LIB, "prepare-principale.mjs"),
      path.join(COCKPIT_LIB, "fumee.mjs"),
      path.join(LIB_E2E, "faux-fournisseur.mjs"),
      path.join(LIB_E2E, "opencode-hors-ligne.jsonc"),
      path.join(RACINE, "app", "Dockerfile"),
    );
  }
  for (const nom of projetsTestDemandes()) fichiers.push(path.join(PROJETS_TEST, nom));
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
  // Mode complet : la référence DEMANDÉE doit, elle, être acceptée (sinon le banc réel s'arrêterait avant de bâtir).
  const refOk = !COMPLET || refAcceptee(REF);
  if (!refOk) dit(`[à blanc] ✗ référence « ${String(REF).slice(0, 60)} » refusée : branche, étiquette ou SHA attendus`);
  const ok = refuses === refus.length && manquants === 0 && refOk;
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
    // Archives du cockpit réel (mode complet) : ici, jamais `./archives` du dépôt.
    archives: path.join(dossier, "archives"),
    env: path.join(dossier, "banc.env"),
    journal: path.join(dossier, "banc.log"),
  };
  for (const d of [chemins.sortie, chemins.certs, chemins.certsPrive, chemins.source, chemins.ws, chemins.archives]) fs.mkdirSync(d, { recursive: true });
  fichierJournal = chemins.journal;

  const fichiersCompose = [COMPOSE_PRODUIT, COMPOSE_PROJETS, composeDuMode()];
  if (values.contournement && !COMPLET) fichiersCompose.push(COMPOSE_CONTOURNEMENT);
  const bilan = { projet, mode: COMPLET ? "complet" : "hors-ligne", image: IMAGE, debut: Date.now(), portes: [], mesures: {}, nettoyage: null };
  let demarre = false;
  let cockpitBati = null;

  try {
    dire(`banc ${projet} — dossier ${dossier}`);
    // Tout ce qui peut refuser sans Docker refuse ICI : scénarios (portes de portes/ comprises) et projets de test.
    const catalogue = await scenariosDuMode();
    const demandes = (values.scenarios ?? "").trim();
    const choisis = demandes === "" ? catalogue : catalogue.filter((s) => demandes.split(",").map((x) => x.trim()).includes(s.id));
    if (choisis.length === 0) throw new Error(`--scenarios : aucun scénario connu dans « ${demandes} » (connus : ${catalogue.map((s) => s.id).join(", ")})`);
    const projetsTest = projetsTestDemandes();
    const pileAvant = await pileUtilisateur();
    ecrire(path.join(chemins.sortie, "pile-utilisateur-avant.txt"), `${pileAvant.join("\n")}\n`);
    dire(`pile de l'utilisateur relevée : ${pileAvant.length} ligne(s) opencode-cockpit-* / ocauto-*`);

    await dockerOuEchec(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    await dockerOuEchec(["image", "inspect", "--format", "{{.Id}}", IMAGE_APP]);

    // Mode complet : le cockpit RÉEL jetable, bâti depuis une copie git archive avec SALLE_OUVERTE basculée (dans la copie
    // seulement). L'image donnée par --image-cockpit est prise telle quelle ; sinon le banc la bâtit ici.
    if (COMPLET) {
      if (values["image-cockpit"]) {
        await dockerOuEchec(["image", "inspect", "--format", "{{.Id}}", IMAGE_COCKPIT]);
        // Image donnée : ce qu'elle livre n'est pas lisible ici. Tenu pour NON livré : la fumée dira « en attente », jamais un
        // faux vert ; pour une mesure qui compte, laisser le banc bâtir depuis --ref.
        cockpitBati = { image: IMAGE_COCKPIT, ref: "(image donnée)", activation: { choixOmo: false, battementDeclenche: false, livree: false } };
        dire(`cockpit réel : image donnée ${IMAGE_COCKPIT} (aucune construction ; livraison inconnue, tenue pour non livrée)`);
      } else {
        cockpitBati = await preparerCockpit({ racineDepot: RACINE, ref: REF, cible: path.join(chemins.dossier, "cockpit-src"), image: IMAGE_COCKPIT, docker, dire });
      }
      bilan.cockpit = { image: cockpitBati.image, sha: cockpitBati.sha ?? null, ref: cockpitBati.ref, activation: cockpitBati.activation ?? null };
      ecrire(path.join(chemins.sortie, "cockpit-bati.json"), `${JSON.stringify(bilan.cockpit, null, 2)}\n`);
    }

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
    await preparerProjets(chemins.ws, { avecGit: !values["sans-git"], projetsTest });
    if (projetsTest.length > 0) dire(`projets de test recopiés comme projets préparés : ${projetsTest.join(", ")}`);
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
    // Jeton du cockpit réel : 64 hexadécimaux, format d'install.ps1 (sans lui, la 1.0.5 ne sert ni preuve ni ticket). Tiré ici,
    // jamais affiché ; il ne sert qu'en mode complet, mais on le tire toujours pour que le fichier d'environnement soit stable.
    const cockpitJeton = randomBytes(32).toString("hex");
    // Mot de passe de l'instance PRINCIPALE, distinct de celui de la salle (comme install.ps1 : jamais le même secret des deux côtés).
    const motDePassePrincipal = randomBytes(24).toString("base64url");
    ecrire(chemins.env, fichierEnv({ chemins, motDePasse, motDePassePrincipal, jetonPilote, cockpitJeton }), 0o600);
    dire(`fichier d'environnement écrit en 0600 (mot de passe et jeton tirés au hasard, jamais affichés)`);

    const compose = (args, options = {}) => {
      verifierProjet(projet);
      const base = ["compose", "--project-name", projet, "--env-file", chemins.env];
      for (const f of fichiersCompose) base.push("--file", f);
      base.push("--profile", "omo");
      return docker([...base, ...args], { cwd: RACINE, delaiMs: options.delaiMs ?? 600_000, silencieux: options.silencieux !== false });
    };

    const verif = await compose(["config", "--quiet"]);
    if (verif.code !== 0) throw new Error(`docker compose config refusé :\n${String(verif.erreur).slice(-1200)}`);
    dire("les fichiers compose se composent sans erreur");

    demarre = true;
    const services = servicesDuMode();
    dire(
      COMPLET
        ? `démarrage du banc complet (profil omo) — cockpit réel, réseau fermé, aucun port 7777${BATTEMENT_BANC ? " ; battement et liste des projets par les pilotes du banc (--battement-banc)" : ""}`
        : "démarrage de la salle (profil omo) — aucun cockpit, aucun port 7777",
    );
    const monte = await compose(["up", "--detach", "--wait", "--wait-timeout", "240", ...services], { delaiMs: 600_000 });
    ecrire(path.join(chemins.sortie, "compose-up.log"), `${monte.sortie}\n${monte.erreur}\n`);
    if (monte.code !== 0) {
      // `--wait` échoue aussi quand un service jetable a fini : on ne renonce que si `opencode-omo` n'est pas là.
      dire(`compose up --wait a rendu ${monte.code} : on vérifie l'état réel de la salle`);
    }

    const ctx = await construireContexte({ projet, chemins, compose, motDePasse, jetonPilote, bilan });
    if (COMPLET) {
      ctx.cockpitPort = PORT_COCKPIT;
      ctx.cockpitJeton = cockpitJeton;
      // La salle vue par le cockpit passe par l'espion, comme le cockpit lui-même : c'est ce client qui sonde le repos (lib-arret).
      ctx.clientSalle = clientOmo({ port: PORT_ESPION, utilisateur: "opencode", motDePasse });
      ctx.activationLivree = cockpitBati?.activation?.livree === true;
      ctx.battementCockpit = cockpitBati?.activation?.battementDeclenche === true;
      ctx.battementBanc = BATTEMENT_BANC;
      bilan.battement = ctx.battementCockpit ? "cockpit" : BATTEMENT_BANC ? "banc (--battement-banc)" : "aucun";
    }
    // Mode complet : la fumée et les portes attendent elles-mêmes la salle, par le cockpit (qui peut ne jamais la démarrer).
    const pret = COMPLET ? true : await jusqua(async () => (await ctx.etat())?.phase === "opencode-lance", { delaiMs: 240_000, pasMs: 1000 });
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
    } else if (COMPLET) {
      dire(`mode complet : la salle est attendue par la fumée, derrière le cockpit réel (battement : ${bilan.battement})`);
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
      // « En attente » : une étape que la tête éprouvée ne LIVRE pas encore (le cockpit réel sur une tête d'avant le train de la
      // vague 4). Ni verte, ni rouge : nommée, avec sa raison, dans le journal et dans bilan.json. Une porte dont tous les points
      // observés sont verts mais qui attend encore est dite « VERTE, PARTIELLE » — jamais « VERTE » tout court.
      const enAttente = Array.isArray(resultat.enAttente) ? resultat.enAttente : [];
      const ok = resultat.ok !== false && points.every((p) => p.ok);
      bilan.portes.push({ id: scenario.id, titre: scenario.titre, ok, dureeMs: Date.now() - debut, points, ...(enAttente.length > 0 ? { enAttente } : {}) });
      if (resultat.mesures) Object.assign(bilan.mesures, resultat.mesures);
      for (const p of points) dire(`  ${p.ok ? "✓" : "✗"} ${p.nom}${p.detail ? ` — ${String(p.detail).slice(0, 300)}` : ""}`);
      for (const e of enAttente) dire(`  … EN ATTENTE : ${e.etape} — ${String(e.raison).slice(0, 300)}`);
      const partielle = ok && enAttente.length > 0 ? `, PARTIELLE : ${enAttente.length} étape(s) en attente` : "";
      dire(`--- porte ${scenario.id} : ${ok ? "VERTE" : "ROUGE"}${partielle} (${Math.round((Date.now() - debut) / 1000)} s)`);
    }

    // Lien M22 (reste R-2) : le relevé sous charge de G1 est jugé contre les constantes du test du compose, au moment même où il
    // est pris. G1 a déjà écrit g1-stats.json ; un relevé plus haut que la constante rend ce lien ROUGE, avec la ligne à changer.
    if (bilan.mesures.M22) {
      const source = fs.readFileSync(path.join(RACINE, ...FICHIER_CONSTANTES_M22.split("/")), "utf8");
      const lien = jugerLienM22(bilan.mesures.M22, constantesM22(source));
      bilan.portes.push({ id: "lien-m22", titre: `R-2 : relevé M22 de G1 contre les constantes de ${FICHIER_CONSTANTES_M22}`, ok: lien.ok, dureeMs: 0, points: lien.points });
      for (const p of lien.points) dire(`  ${p.ok ? "✓" : "✗"} ${p.nom} — ${p.detail}`);
      dire(`--- lien M22 : ${lien.ok ? "VERT" : "ROUGE"}`);
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
    bilan.enAttente = bilan.portes.flatMap((p) => (p.enAttente ?? []).map((e) => ({ porte: p.id, ...e })));
    ecrire(path.join(chemins.sortie, "bilan.json"), `${JSON.stringify(bilan, null, 2)}\n`);
    const attente = bilan.enAttente.length > 0 ? `, ${bilan.enAttente.length} étape(s) EN ATTENTE` : "";
    const mention = `${horsJeu > 0 ? ` (${horsJeu} sans objet)` : ""}${attente}`;
    dire(`bilan : ${jugees.filter((p) => p.ok).length}/${jugees.length} portes vertes${mention} — ${bilan.vert ? "VERT" : "ROUGE"}`);
    dire(`sorties : ${chemins.sortie}`);
  }
  return bilan.vert ? 0 : 1;
}

/**
 * Deux projets jetables : un projet ouvert par le banc, un second préparé mais jamais ouvert (M31).
 *
 * Par défaut ce sont de VRAIS dépôts git, avec un commit et une modification non commitée : sans `.git`, la porte `git`
 * n'aurait rien à protéger, et la mesure M23 (`git status` et `git diff` sur un dépôt que la salle ne peut pas écrire)
 * n'observerait rien. C'est aussi le cas RÉEL d'un poste : un dossier de travail sans aucun dépôt n'existe guère.
 *
 * `--sans-git` retire les dépôts. Avant L16c, c'était la seule façon d'aller mesurer tout le reste sur un hôte Windows : un
 * `.git` monté `:ro` y restait inscriptible par ses alias, et la sonde du superviseur fermait la salle. Depuis L16c (dossier de
 * travail en lecture seule, écriture par exception), la salle démarre avec de vrais dépôts. Le banc dégradé le dit toujours
 * à chaque exécution, pour que personne ne le prenne pour un banc complet.
 *
 * L'identité git est locale au dépôt et factice : rien de la machine n'entre dans ces projets.
 *
 * Deux DOSSIERS de premier niveau (`src`, `docs`) à côté des deux fichiers (train de V3 de la 2 ter, L16c) : `install.ps1` ouvre
 * en écriture chaque entrée de premier niveau, dossiers ET fichiers, et la porte `git` mesure l'écriture légitime dans un dossier
 * ouvert, l'alias d'un dossier ouvert, la remontée `..` depuis lui et le lien dur entre deux dossiers ouverts.
 */
async function preparerProjets(ws, { avecGit = true, projetsTest = [] } = {}) {
  const deposerGit = async (racine) => {
    const git = (args) => lancer("git", ["-C", racine, ...args], { delaiMs: 60_000 });
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Banc de la salle"]);
    await git(["config", "user.email", "banc@exemple.invalid"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["add", "-A"]);
    await git(["commit", "-m", "Projet jetable du banc"]);
  };
  for (const [nom, contenu] of [
    ["projet-ouvert", "Projet du banc, ouvert par la salle.\n"],
    ["projet-temoin", "Projet préparé, jamais ouvert : témoin de la mesure M31.\n"],
  ]) {
    const racine = path.join(ws, nom);
    fs.mkdirSync(path.join(racine, "src"), { recursive: true });
    fs.mkdirSync(path.join(racine, "docs"), { recursive: true });
    fs.writeFileSync(path.join(racine, "LISEZMOI.md"), contenu);
    fs.writeFileSync(path.join(racine, "notes.txt"), `Fichier témoin de ${nom}.\n`);
    fs.writeFileSync(path.join(racine, "src", "app.js"), `// Code jetable de ${nom}.\nexport const nom = "${nom}";\n`);
    fs.writeFileSync(path.join(racine, "docs", "guide.md"), `Guide jetable de ${nom}.\n`);
    if (!avecGit) continue;
    await deposerGit(racine);
    // Une modification laissée en travail : `git status` et `git diff` ont alors quelque chose à dire (M23).
    fs.appendFileSync(path.join(racine, "notes.txt"), "Ligne ajoutée après le commit, pour que git diff ne soit pas vide.\n");
  }
  // Projets de test du banc (`projets/`, portes G7 et G13 de la vague 5), recopiés tels quels HORS du dépôt, sous un nom qui ne
  // peut pas heurter les deux projets ci-dessus. Aucun n'est exécuté ici : le banc les dépose, la salle les monte.
  for (const nom of projetsTest) {
    const racine = path.join(ws, `projet-test-${nom}`);
    fs.cpSync(path.join(PROJETS_TEST, nom), racine, { recursive: true, verbatimSymlinks: true });
    if (avecGit) await deposerGit(racine);
  }
}

function fichierEnv({ chemins, motDePasse, motDePassePrincipal, jetonPilote, cockpitJeton }) {
  // Une valeur par ligne, sans guillemets : Compose lit ce fichier tel quel. Le mot de passe n'apparaît nulle part ailleurs.
  // Le mode complet ajoute de quoi câbler le cockpit réel et l'instance principale ; ces variables sont inertes en hors ligne
  // (banc.compose.yml ne les cite pas), mais toujours écrites pour que le fichier ait la même forme.
  const lignes = [
    "# Fichier d'environnement du banc (L21/L21b). Généré à chaque exécution, en 0600, supprimé à la fin. Ne jamais copier ailleurs.",
    `COMPOSE_PROJECT_NAME=${PREFIXE_PROJET}${ID}`,
    `WORKSPACE_DIR=${barre(chemins.ws)}`,
    `COCKPIT_OMO_IMAGE=${IMAGE}`,
    `COCKPIT_APP_IMAGE=${IMAGE_APP}`,
    // Image opencode de l'instance principale : l'image du banc en hors ligne (les pilotes s'en servent), la vraie image
    // opencode en mode complet (instance principale réelle devant le faux fournisseur).
    `COCKPIT_OPENCODE_IMAGE=${COMPLET ? `sal11/opencode:${ETIQUETTE_BANC}` : IMAGE_APP}`,
    `COCKPIT_REEL_IMAGE=${IMAGE_COCKPIT}`,
    `OPENCODE_OMO_PASSWORD=${motDePasse}`,
    `OPENCODE_SERVER_PASSWORD=${motDePassePrincipal}`,
    `COCKPIT_TOKEN=${cockpitJeton}`,
    "COCKPIT_COPILOT_API_URL=https://api.githubcopilot.com",
    "COCKPIT_GITHUB_ENTERPRISE_DOMAIN=",
    "NODE_EXTRA_CA_CERTS=/certs/ca.pem",
    "HTTP_PROXY=",
    "HTTPS_PROXY=",
    "NO_PROXY=",
    // Port publié du cockpit (compose du produit : 127.0.0.1:${COCKPIT_PORT}:7777) : celui du banc, jamais 7777 ni un port déjà
    // publié par un service du banc. C'est la SEULE publication du cockpit : cockpit.compose.yml n'en ajoute pas.
    `COCKPIT_PORT=${PORT_COCKPIT}`,
    `BANC_ARCHIVES=${barre(chemins.archives)}`,
    `BANC_LIB=${barre(path.join(BANC, "lib"))}`,
    `BANC_COCKPIT=${barre(COCKPIT_LIB)}`,
    `BANC_LIB_E2E=${barre(LIB_E2E)}`,
    `BANC_OUT=${barre(chemins.sortie)}`,
    `BANC_CERTS=${barre(chemins.certs)}`,
    `BANC_CERTS_PRIVE=${barre(chemins.certsPrive)}`,
    `BANC_SOURCE=${barre(chemins.source)}`,
    `BANC_PORT_ESPION=${PORT_ESPION}`,
    `BANC_PORT_PILOTE=${PORT_PILOTE}`,
    `BANC_PORT_COCKPIT=${PORT_COCKPIT}`,
    `BANC_PORT_FOURNISSEUR=${PORT_FOURNISSEUR}`,
    `BANC_HTTP_CONFIRMED=${new Date().toISOString().slice(0, 19)}Z`,
    `BANC_JETON_PILOTE=${jetonPilote}`,
    `BANC_IP_COPILOT=${IP_COPILOT}`,
    `BANC_SUBNET=${SOUS_RESEAU}`,
    "TZ=Europe/Paris",
  ];
  return `${lignes.join("\n")}\n`;
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
    /** Texte de la surcharge des projets écrite par `install.ps1 -OmoProjetsSeulement` pour ce banc (porte `sup`). */
    surcharge: () => (fs.existsSync(COMPOSE_PROJETS) ? fs.readFileSync(COMPOSE_PROJETS, "utf8") : ""),
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
  const code = values["a-blanc"] ? await aBlanc() : await principal();
  process.exit(code);
} catch (err) {
  process.stderr.write(`ARRÊT : ${String(err?.message ?? err).slice(0, 800)}\n`);
  process.exit(1);
}
