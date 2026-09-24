// Banc COMPLET de la salle (plan 2 bis-2 ter §6, fiche L21b ; spécification §7.6 l.1160, §7.10 l.1219-1223, l.1227 ; restes R-2,
// R-3, R-7 et R-9 de la clôture 2 bis) : les gardes du banc tenues SANS Docker.
//
// - cockpit réel jetable (e2e/omo-banc/cockpit/) : `SALLE_OUVERTE` basculée dans une copie `git archive` SEULEMENT, jamais dans le
//   dépôt ; une référence qui ressemble à une option est refusée avant git ; le compose du cockpit réel est hors ligne PAR LE
//   RÉSEAU, ne publie que sur la boucle locale et ne monte rien du dépôt ;
// - espion : il compte `POST …/command`, envois, sessions et types d'événements, sans rien garder d'un corps ni d'une autorisation ;
// - bibliothèques communes à L27a et L27b (lib-activation, lib-arret) et bibliothèque de scénarios du faux fournisseur (chaque
//   série acceptée par le VRAI faux, en processus enfant) ;
// - M28 (R-7) : répondeur du banc et directives marquées alignées sur la détection 2 du cockpit ;
// - R-2 : lien automatique du relevé M22 aux constantes d'omo-compose.test.ts ;
// - R-3, R-9 : l'aide et le README disent les deux exécutions obligatoires et le lancement détaché.
//
// Les modules du banc sont des scripts `.mjs` sans déclarations : ils sont chargés par import DYNAMIQUE et typés ici, au plus
// juste de ce que le test lit. Aucun conteneur, aucun réseau hors de la boucle locale, aucune pause fixe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { until } from "./test-support/helpers.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");
const BANC = path.join(RACINE, "e2e", "omo-banc");
const lireBanc = (relatif: string): string => fs.readFileSync(path.join(BANC, ...relatif.split("/")), "utf8");
const charger = async <T>(relatif: string): Promise<T> => (await import(pathToFileURL(path.join(BANC, ...relatif.split("/"))).href)) as T;

// --- Formes lues des modules du banc --------------------------------------------------------------------------------------------

interface Activation {
  choixOmo: boolean;
  battementDeclenche: boolean;
  livree: boolean;
}
interface Preparer {
  FICHIER_SALLE_OUVERTE: string;
  basculerSalleOuverte(texte: string): { texte: string; remplacements: number };
  refAcceptee(ref: unknown): boolean;
  battementDeclencheDans(cible: string): boolean;
  activationLivreeDansCopie(cible: string): Activation;
  preparerCockpit(o: { racineDepot: string; ref?: string; cible: string; construire?: boolean; dire?: (t: string) => void }): Promise<{ sha: string; activation: Activation; construite: boolean }>;
}
interface Compteurs {
  requete(classe: string | null): void;
  ouvrirFlux(n: number, chemin: string): { evenement(type: string | null): void; fermer(): void };
  instantane(): InstantaneEspion;
}
interface InstantaneEspion {
  at: number;
  requetes: Record<string, number>;
  flux: { n: number; chemin: string; ouvert: boolean; evenements: number; types: Record<string, number> }[];
}
interface Espion {
  CHEMIN_COMPTEURS: string;
  classerRequete(methode: string, chemin: string): string | null;
  typeDuBloc(bloc: string): string | null;
  creerCompteurs(maintenant?: () => number): Compteurs;
}
interface Reponse {
  code: number;
  corps: string;
}
interface ClientFactice {
  brut(methode: string, chemin: string, corps?: unknown, options?: { entetes?: Record<string, string> }): Promise<Reponse>;
}
interface LibActivation {
  CONFIRMATION: Readonly<Record<string, string>>;
  activer(client: ClientFactice, rootId: string, plafondUsd: unknown): Promise<{ code: number; erreur: string | null }>;
  ouvrirSalle(client: ClientFactice, projet: string): Promise<{ code: number; rootId: string | null }>;
  envoyer(client: ClientFactice, rootId: string, directory: string, texte: string, o?: { model?: unknown }): Promise<{ code: number }>;
  modeleDeLaSalle(providers: unknown, preferee?: string): { providerID: string; modelID: string } | null;
  activerPuisEnvoyer(client: ClientFactice, o: { rootId: string; directory: string; plafondUsd: string; texte: string; model: unknown }): Promise<{ envoi: unknown; envoye: boolean }>;
}
interface Ecart {
  commandes: number;
  envois: number;
  sessionsHttp: number;
  sessionsCreees: number;
  messages: number;
  appelsFournisseur: number;
  fluxObserves: number;
}
interface Releve {
  at: number;
  espion: Partial<InstantaneEspion>;
  fournisseur: number;
}
interface LibArret {
  ecartActivite(avant: Releve, apres: Releve): Ecart;
  silence(ecart: Ecart): boolean;
  occupee(statut: unknown): boolean;
  comparerEmpreintes(avant: unknown, apres: unknown): { racine: string; chemin: string; ecart: string }[];
  attendreNouveauDemarrage(lire: () => unknown, avant: string | null, o?: { phase?: string; delaiMs?: number; pasMs?: number }): Promise<{ ok: boolean; startId: string | null }>;
}
interface ScenariosFaux {
  BORNES_FAUX: { file: number; outils: number; delaiMaxMs: number };
  DIRECTIVES_MARQUEES: readonly string[];
  MOTIF_DIRECTIVE: RegExp;
  directivesDe(texte: string): string[];
  outil(nom: string, args?: Record<string, unknown>): unknown;
  appels(...outils: unknown[]): unknown;
  lecture(p: string): unknown;
  recherche(motif: string, chemin?: string): unknown;
  motif(motif: string, chemin?: string): unknown;
  liste(chemin?: string): unknown;
  commande(c: string): unknown;
  tache(o?: object): unknown;
  tacheParCategorie(o?: object): unknown;
  appelAgent(o?: object): unknown;
  outilMcp(): unknown;
  competence(nom: string): unknown;
  unOutilPuisFin(appel: unknown): unknown[];
  serie429(n?: number): unknown[];
  lente(ms?: number): unknown;
  sessions(n: number): unknown[];
  trenteSessions(): unknown[];
  todoInachevee(): unknown[];
  prometheusEcrit(dossier: string): unknown[];
  atlasEcritDirect(dossier: string): unknown[];
}
interface Hooks {
  decisionRepondeurBanc(demande: unknown, dossier?: string): "once" | "reject";
  nomAgentPourCle(agents: unknown, cle: string): string | null;
  tracesAutomatismes(journal: string): { lignes: number; parNom: Record<string, number>; phrases: Record<string, string[]>; directives: string[] };
  releveStocke(messages: unknown): { messages: number; outils: Record<string, number>; directives: string[] };
}
interface LienM22 {
  FICHIER_CONSTANTES_M22: string;
  constantesM22(source: string): { memMaxMio: number; pidsMax: number; releveMaxPublie: number } | null;
  jugerLienM22(m22: unknown, constantes: unknown): { ok: boolean; points: { nom: string; ok: boolean; detail: string }[] };
}
interface Fumee {
  PLAFOND_FUMEE: string;
  default: { id: string; executer(ctx: Record<string, unknown>): Promise<{ sansObjet?: string }> };
}

const preparer = await charger<Preparer>("cockpit/preparer.mjs");
const espion = await charger<Espion>("lib/espion.mjs");
const libActivation = await charger<LibActivation>("lib/lib-activation.mjs");
const libArret = await charger<LibArret>("lib/lib-arret.mjs");
const faux = await charger<ScenariosFaux>("lib/scenarios-faux.mjs");
const hooks = await charger<Hooks>("scenarios/hooks-gardes.mjs");
const lienM22 = await charger<LienM22>("lib/lien-m22.mjs");
const fumee = await charger<Fumee>("cockpit/fumee.mjs");

// --- Outils ---------------------------------------------------------------------------------------------------------------------

const temporaires: string[] = [];
const dossierTemporaire = (prefixe: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  temporaires.push(d);
  return d;
};
after(() => {
  for (const d of temporaires) fs.rmSync(d, { recursive: true, force: true });
});

/** Port libre de la boucle locale (le système le choisit, on le rend aussitôt). */
async function portLibre(): Promise<number> {
  const serveur = net.createServer();
  serveur.listen(0, "127.0.0.1");
  await once(serveur, "listening");
  const adresse = serveur.address();
  serveur.close();
  await once(serveur, "close");
  assert.ok(adresse !== null && typeof adresse === "object");
  return adresse.port;
}

/** Requête node:http sur la boucle locale (fetch refuse certains ports choisis par le système). */
function demander(port: number, methode: string, chemin: string, corps?: string, entetes: Record<string, string> = {}): Promise<{ statut: number; corps: string; entetes: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...entetes };
    if (corps !== undefined) {
      h["content-type"] ??= "application/json";
      h["content-length"] = String(Buffer.byteLength(corps));
    }
    const req = http.request({ host: "127.0.0.1", port, path: chemin, method: methode, headers: h, agent: false }, (res) => {
      const morceaux: Buffer[] = [];
      res.on("data", (m: Buffer) => morceaux.push(m));
      res.on("end", () => resolve({ statut: res.statusCode ?? 0, corps: Buffer.concat(morceaux).toString("utf8"), entetes: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(corps);
  });
}

/** Lance un script du banc en processus enfant ; rend son code et sa sortie. PATH réduit à node : aucun docker trouvable. */
async function lancerBanc(args: string[]): Promise<{ code: number; sortie: string }> {
  const enfant = spawn(process.execPath, [path.join(BANC, "run-banc.mjs"), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: path.dirname(process.execPath) },
  });
  let sortie = "";
  enfant.stdout.on("data", (b: Buffer) => {
    sortie += b;
  });
  enfant.stderr.on("data", (b: Buffer) => {
    sortie += b;
  });
  const [code] = (await once(enfant, "close")) as [number];
  return { code, sortie };
}

// --- 1. Cockpit réel jetable ----------------------------------------------------------------------------------------------------

describe("L21b, cockpit réel jetable : SALLE_OUVERTE basculée dans la copie git archive SEULEMENT", () => {
  it("la bascule exige exactement UNE déclaration ; le fichier du dépôt en porte une, fausse", () => {
    const depot = fs.readFileSync(path.join(RACINE, ...preparer.FICHIER_SALLE_OUVERTE.split("/")), "utf8");
    const une = preparer.basculerSalleOuverte(depot);
    assert.equal(une.remplacements, 1);
    assert.match(une.texte, /export const SALLE_OUVERTE = true;/);
    assert.doesNotMatch(une.texte, /export const SALLE_OUVERTE = false;/);
    assert.equal(preparer.basculerSalleOuverte("// rien ici\n").remplacements, 0);
    const deux = "export const SALLE_OUVERTE = false;\nexport const SALLE_OUVERTE = false;\n";
    assert.equal(preparer.basculerSalleOuverte(deux).remplacements, 2, "deux déclarations : l'appelant doit refuser (une seule attendue)");
    assert.match(lireBanc("cockpit/preparer.mjs"), /remplacements !== 1\) \{\s*throw new Error/, "preparerCockpit refuse une image bâtie sur zéro ou deux bascules");
  });

  it("extraction réelle de HEAD (sans construction) : la copie porte true, le dépôt reste à false", { timeout: 180_000 }, async () => {
    const cible = path.join(dossierTemporaire("sal11-l21b-copie-"), "cockpit-src");
    const r = await preparer.preparerCockpit({ racineDepot: RACINE, ref: "HEAD", cible, construire: false });
    assert.equal(r.construite, false);
    assert.match(r.sha, /^[0-9a-f]{40}$/);
    assert.match(fs.readFileSync(path.join(cible, "app", "server", "wiring-11.ts"), "utf8"), /export const SALLE_OUVERTE = true;/);
    const depot = fs.readFileSync(path.join(RACINE, "app", "server", "wiring-11.ts"), "utf8");
    assert.match(depot, /export const SALLE_OUVERTE = false;/, "le dépôt n'est JAMAIS basculé");
    assert.doesNotMatch(depot, /SALLE_OUVERTE = true/);
    // Le tar intermédiaire ne survit pas, et git archive a suivi .gitattributes (scripts de l'image en LF).
    assert.equal(fs.existsSync(`${cible}.tar`), false);
    assert.equal(fs.readFileSync(path.join(cible, "docker", "opencode-omo", "supervisor.sh"), "utf8").includes("\r\n"), false);
    assert.equal(typeof r.activation.livree, "boolean");
  });

  it("une référence qui ressemble à une option (ou qui n'est pas un nom) est refusée AVANT tout appel à git", async () => {
    for (const bonne of ["HEAD", "HEAD~1", "chantier/1.1-salle", "7e5f9c4", "v1.0.5", "tmp/sal-L21b", "HEAD^"]) assert.equal(preparer.refAcceptee(bonne), true, bonne);
    for (const mauvaise of ["--output=/tmp/x", "-x", "", "a b", "a..b", "a;b", "$(id)", "x".repeat(201), 42, null]) assert.equal(preparer.refAcceptee(mauvaise), false, String(mauvaise));
    const cible = path.join(dossierTemporaire("sal11-l21b-ref-"), "jamais");
    await assert.rejects(preparer.preparerCockpit({ racineDepot: RACINE, ref: "--output=/tmp/x", cible, construire: false }), /référence refusée/);
    assert.equal(fs.existsSync(cible), false, "rien n'est créé avant le refus");
  });

  it("le déclencheur du battement n'est reconnu que sur un APPEL en code de production", () => {
    const arbre = (fichiers: Record<string, string>): string => {
      const racine = dossierTemporaire("sal11-l21b-src-");
      for (const [rel, texte] of Object.entries(fichiers)) {
        const f = path.join(racine, "app", "server", ...rel.split("/"));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, texte);
      }
      return racine;
    };
    const declarations = {
      "omo-control.ts": "startHeartbeat() {\n}\n",
      "omo-contracts.ts": "startHeartbeat(): void;\n",
      "omo-control-module.ts": "startHeartbeat: () => undefined,\n",
    };
    assert.equal(preparer.battementDeclencheDans(arbre(declarations)), false, "déclaration, signature et port neutre ne sont pas des appels");
    assert.equal(preparer.battementDeclencheDans(arbre({ ...declarations, "x.test.ts": "c.ports.omoControl.startHeartbeat();\n" })), false, "un test n'est pas la production");
    assert.equal(preparer.battementDeclencheDans(arbre({ ...declarations, "omo-activation.ts": "c11.ports.omoControl.startHeartbeat();\n" })), true);
    assert.equal(preparer.battementDeclencheDans(arbre({ ...declarations, "sous/instance.ts": "ports.omoControl.startHeartbeat( );\n" })), true, "sous-dossier compris");
    const livree = arbre({
      "omo-activation.ts": "x.startHeartbeat();\n",
      "conversation-autonomy.ts": 'const Corps = z.object({ choix: z.enum(["off", "omo"]) });\n',
    });
    assert.deepEqual(preparer.activationLivreeDansCopie(livree), { choixOmo: true, battementDeclenche: true, livree: true });
  });
});

// --- 2. Compose du cockpit réel -----------------------------------------------------------------------------------------------

interface ServiceCompose {
  ports?: string[];
  environment?: Record<string, unknown>;
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
  profiles?: string[];
  healthcheck?: { disable?: boolean };
  image?: string;
}
interface Compose {
  services: Record<string, ServiceCompose>;
  networks: Record<string, { internal?: boolean; driver_opts?: Record<string, string>; ipam?: unknown }>;
}

describe("L21b, compose du cockpit réel : hors ligne par le RÉSEAU, boucle locale seulement, rien monté du dépôt", () => {
  const texte = lireBanc("cockpit/cockpit.compose.yml");
  const compose = parseYaml(texte) as Compose;
  const reseaux = (s: ServiceCompose): string[] => (Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}));

  it("le réseau du projet est fermé ; les publications passent par un pont sans traduction d'adresse", () => {
    assert.equal(compose.networks.default?.internal, true, "le réseau default du banc complet doit être internal: true");
    assert.equal(compose.networks["banc-front"]?.driver_opts?.["com.docker.network.bridge.enable_ip_masquerade"], "false");
    assert.equal(compose.networks["banc-front"]?.internal, undefined);
  });

  it("chaque publication : 127.0.0.1, un port du banc (BANC_PORT_*), jamais 7777, et le service est sur banc-front", () => {
    let publies = 0;
    for (const [nom, service] of Object.entries(compose.services)) {
      for (const port of service.ports ?? []) {
        publies += 1;
        assert.match(port, /^127\.0\.0\.1:\$\{BANC_PORT_[A-Z]+\}:\d+$/, `${nom} : ${port}`);
        assert.doesNotMatch(port, /7777/, `${nom} : ${port}`);
        assert.ok(reseaux(service).includes("banc-front"), `${nom} publie un port sans être sur banc-front`);
      }
    }
    assert.equal(publies, 3, "espion, faux Copilot, faux fournisseur (le cockpit publie par COCKPIT_PORT)");
  });

  it("le cockpit n'AJOUTE aucune publication (Compose fusionne les listes) : son port vient de COCKPIT_PORT, posé par le banc", () => {
    const cockpit = compose.services.cockpit;
    assert.ok(cockpit !== undefined);
    assert.equal(cockpit.ports, undefined, "une liste ports ici s'ajouterait à celle du produit (127.0.0.1:${COCKPIT_PORT}:7777)");
    const banc = fs.readFileSync(path.join(BANC, "run-banc.mjs"), "utf8");
    assert.match(banc, /`COCKPIT_PORT=\$\{PORT_COCKPIT\}`/, "COCKPIT_PORT vient de PORT_COCKPIT");
    const ports = [...banc.matchAll(/^const PORT_[A-Z]+ = (\d+);$/gm)].map((m) => Number(m[1]));
    assert.equal(ports.length, 4);
    assert.equal(new Set(ports).size, 4, "quatre ports du banc, tous différents");
    assert.ok(!ports.includes(7777));
  });

  it("aucun montage vers la copie de travail : /certs et /archives du produit remplacés par des dossiers du banc", () => {
    const volumes = (nom: string) => compose.services[nom]?.volumes ?? [];
    assert.ok(volumes("cockpit").includes("${BANC_CERTS}:/certs:ro"));
    assert.ok(volumes("cockpit").includes("${BANC_ARCHIVES}:/archives"));
    assert.ok(volumes("opencode").includes("${BANC_CERTS}:/certs:ro"));
    assert.ok(volumes("opencode-omo").includes("${BANC_CERTS}:/certs:ro"));
    for (const [nom, service] of Object.entries(compose.services)) {
      for (const v of service.volumes ?? []) assert.doesNotMatch(v, /^\.\.?\//, `${nom} monte un chemin relatif au dépôt : ${v}`);
    }
  });

  it("aucune variable n'ouvre la salle (jamais d'environnement pour SALLE_OUVERTE) ; la salle garde son seul réseau fermé", () => {
    assert.doesNotMatch(texte.replace(/^\s*#.*$/gm, ""), /SALLE_OUVERTE/, "SALLE_OUVERTE ne se bascule que dans la copie, jamais par une variable");
    const salle = compose.services["opencode-omo"];
    assert.ok(salle !== undefined);
    assert.equal(salle.networks, undefined, "la surcharge n'ajoute aucun réseau à la salle");
    assert.equal(salle.ports, undefined, "la salle ne publie rien");
    assert.equal(compose.services.cockpit?.environment?.COCKPIT_OMO, "on");
    // enforceTurn lit un seul réglage pour les deux instances : github-copilot (la salle, devant le faux) ET banc (la principale).
    assert.deepEqual(String(compose.services.cockpit?.environment?.COCKPIT_ALLOWED_PROVIDERS).split(",").sort(), ["banc", "github-copilot"]);
    const principale = fs.readFileSync(path.join(RACINE, "e2e", "lib", "opencode-hors-ligne.jsonc"), "utf8");
    assert.match(principale, /"enabled_providers": \["banc"\]/, "l'instance principale n'active que le faux fournisseur");
    assert.equal(compose.services.cockpit?.environment?.OPENCODE_OMO_URL, "http://banc-espion:4097", "le cockpit parle à la salle À TRAVERS l'espion");
  });

  it("les services du banc n'héritent pas du contrôle de santé de l'image du cockpit (compose up --wait ne les attend pas pour rien)", () => {
    for (const nom of ["faux-fournisseur", "banc-copilot", "banc-espion", "banc-battement"]) {
      assert.equal(compose.services[nom]?.healthcheck?.disable, true, nom);
    }
    const hl = parseYaml(lireBanc("banc.compose.yml")) as Compose;
    for (const nom of ["banc-copilot", "banc-espion", "banc-battement", "banc-precheck"]) assert.equal(hl.services[nom]?.healthcheck?.disable, true, `banc.compose.yml : ${nom}`);
  });

  it("le mot de passe de l'instance principale est distinct de celui de la salle, tous deux tirés au hasard", () => {
    const banc = fs.readFileSync(path.join(BANC, "run-banc.mjs"), "utf8");
    assert.match(banc, /`OPENCODE_OMO_PASSWORD=\$\{motDePasse\}`/);
    assert.match(banc, /`OPENCODE_SERVER_PASSWORD=\$\{motDePassePrincipal\}`/);
    assert.match(banc, /const motDePassePrincipal = randomBytes\(24\)/);
  });
});

// --- 3. Espion -----------------------------------------------------------------------------------------------------------------

describe("L21b, espion : il compte ce qui engage la salle, sans rien garder d'un contenu", () => {
  it("classes de requêtes : POST …/command, envois, sessions, abandons, suppressions ; rien d'autre n'est compté", () => {
    assert.equal(espion.classerRequete("POST", "/session/ses_1/command"), "commande");
    assert.equal(espion.classerRequete("post", "/session/ses_1/prompt_async"), "envoi");
    assert.equal(espion.classerRequete("POST", "/session/ses_1/message"), "message");
    assert.equal(espion.classerRequete("POST", "/session/ses_1/abort"), "abandon");
    assert.equal(espion.classerRequete("DELETE", "/session/ses_1"), "suppression");
    assert.equal(espion.classerRequete("POST", "/session"), "session");
    assert.equal(espion.classerRequete("GET", "/session/ses_1/command"), null, "une lecture n'engage rien");
    assert.equal(espion.classerRequete("POST", "/session/../command"), null);
    assert.equal(espion.classerRequete("POST", "/session/a/b/command"), null);
  });

  it("type d'un bloc d'événements : lu dans les trois enveloppes, jamais fabriqué", () => {
    assert.equal(espion.typeDuBloc('data: {"type":"session.created"}'), "session.created");
    assert.equal(espion.typeDuBloc('data: {"payload":{"type":"message.updated"}}'), "message.updated");
    assert.equal(espion.typeDuBloc('data: {"directory":"/w","payload":{"type":"session.idle"}}'), "session.idle");
    assert.equal(espion.typeDuBloc(": battement"), null);
    assert.equal(espion.typeDuBloc("data: pas du json"), "(autre)");
    assert.equal(espion.typeDuBloc('data: {"type":"Majuscules Espaces"}'), "(autre)");
  });

  it("en service : relais octet pour octet, compteurs justes, journal sans corps ni valeur d'autorisation", { timeout: 60_000 }, async (t) => {
    const MARQUE = "corps-secret-a-ne-jamais-journaliser-7c1";
    const AUTORISATION = "Basic marque-autorisation-9d3";
    const amont = http.createServer((req, res) => {
      if (req.url?.startsWith("/global/event")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"session.created"}\n\n');
        res.write('data: {"payload":{"type":"message.updated"}}\n\n');
        res.end('data: {"payload":{"type":"message.updated"}}\n\n');
        return;
      }
      const morceaux: Buffer[] = [];
      req.on("data", (m: Buffer) => morceaux.push(m));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ recu: Buffer.concat(morceaux).toString("utf8"), autorisation: req.headers.authorization ?? null }));
      });
    });
    amont.listen(0, "127.0.0.1");
    await once(amont, "listening");
    t.after(() => amont.close());
    const adresse = amont.address();
    assert.ok(adresse !== null && typeof adresse === "object");
    const sortie = dossierTemporaire("sal11-l21b-espion-");
    const port = await portLibre();
    const enfant = spawn(process.execPath, [path.join(BANC, "lib", "espion.mjs"), "--port", String(port), "--amont", "127.0.0.1", "--port-amont", String(adresse.port), "--sortie", sortie], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let annonce = "";
    enfant.stdout.on("data", (b: Buffer) => {
      annonce += b;
    });
    t.after(async () => {
      enfant.kill();
      await once(enfant, "close").catch(() => undefined);
    });
    await until(() => annonce.includes('"pret":true'), 10_000);

    const corps = JSON.stringify({ parts: [{ type: "text", text: MARQUE }] });
    const relaye = await demander(port, "POST", "/session/ses_1/prompt_async?directory=%2Fw", corps, { authorization: AUTORISATION });
    assert.equal(relaye.statut, 200);
    assert.deepEqual(JSON.parse(relaye.corps), { recu: corps, autorisation: AUTORISATION }, "l'espion ne transforme rien");
    assert.equal((await demander(port, "POST", "/session/ses_1/command", "{}")).statut, 200);
    assert.equal((await demander(port, "POST", "/session", "{}")).statut, 200);
    const flux = await demander(port, "GET", "/global/event");
    assert.equal(flux.statut, 200);

    const lu = await demander(port, "GET", espion.CHEMIN_COMPTEURS);
    const instant = JSON.parse(lu.corps) as InstantaneEspion;
    assert.equal(instant.requetes.commande, 1);
    assert.equal(instant.requetes.envoi, 1);
    assert.equal(instant.requetes.session, 1);
    const f = instant.flux.find((x) => x.chemin === "/global/event");
    assert.ok(f !== undefined, "le flux est suivi");
    assert.deepEqual(f.types, { "session.created": 1, "message.updated": 2 });

    const journal = await until(() => {
      const chemin = path.join(sortie, "espion.jsonl");
      const texte = fs.existsSync(chemin) ? fs.readFileSync(chemin, "utf8") : "";
      return texte.split("\n").filter((l) => l.trim() !== "").length >= 4 ? texte : undefined;
    }, 10_000);
    assert.ok(!journal.includes(MARQUE), "jamais un corps au journal");
    assert.ok(!journal.includes("marque-autorisation"), "jamais la valeur d'une autorisation");
    assert.match(journal, /"autorisation":true/, "seulement sa présence");
  });

  it("les compteurs gardent tous les flux ouverts, et oublient d'abord les flux fermés", () => {
    let horloge = 0;
    const c = espion.creerCompteurs(() => ++horloge);
    const ouvert = c.ouvrirFlux(1, "/global/event");
    for (let n = 2; n < 40; n += 1) c.ouvrirFlux(n, "/event").fermer();
    ouvert.evenement("session.created");
    const instant = c.instantane();
    assert.ok(instant.flux.length <= 32);
    assert.ok(instant.flux.some((x) => x.n === 1 && x.ouvert && x.types["session.created"] === 1), "le flux ouvert n'est jamais oublié");
  });
});

// --- 4. Bibliothèques communes à L27a et L27b -----------------------------------------------------------------------------------

/** Client de cockpit factice : note chaque appel et rend les codes demandés, dans l'ordre. */
function clientFactice(codes: number[]): ClientFactice & { appels: { methode: string; chemin: string; corps: unknown; entetes: Record<string, string> }[] } {
  const appels: { methode: string; chemin: string; corps: unknown; entetes: Record<string, string> }[] = [];
  return {
    appels,
    async brut(methode, chemin, corps, options) {
      appels.push({ methode, chemin, corps, entetes: options?.entetes ?? {} });
      const code = codes.shift() ?? 200;
      return { code, corps: code >= 400 ? JSON.stringify({ error: "refus-du-test" }) : JSON.stringify({ rootId: "ses_racine", projet: "p" }) };
    },
  };
}

describe("L21b, lib-activation : comme la page, et jamais d'envoi sans activation acceptée", () => {
  it("le montant part en CHAÎNE : un nombre est refusé avant tout appel", async () => {
    const client = clientFactice([]);
    await assert.rejects(libActivation.activer(client, "ses_1", 0.1), TypeError);
    assert.equal(client.appels.length, 0);
    await libActivation.activer(client, "ses_1", "0.10");
    assert.deepEqual(client.appels[0]?.corps, { choix: "omo", plafondUsd: "0.10" });
    assert.equal(client.appels[0]?.entetes["x-cockpit-confirm"], "1", "activation confirmée à chaque demande");
  });

  it("ouverture d'une salle confirmée ; activation refusée → AUCUN envoi", async () => {
    const ouverture = clientFactice([200]);
    const salle = await libActivation.ouvrirSalle(ouverture, "projet-ouvert");
    assert.equal(salle.rootId, "ses_racine");
    assert.equal(ouverture.appels[0]?.chemin, "/api/omo/rooms");
    assert.deepEqual(ouverture.appels[0]?.entetes, { ...libActivation.CONFIRMATION });

    const model = { providerID: "github-copilot", modelID: "faux-m1" };
    const refus = clientFactice([409]);
    const r = await libActivation.activerPuisEnvoyer(refus, { rootId: "ses_1", directory: "/workspace/p", plafondUsd: "0.10", texte: "x", model });
    assert.equal(r.envoye, false);
    assert.equal(r.envoi, null);
    assert.equal(refus.appels.length, 1, "un seul appel : l'activation refusée");
    assert.ok(!refus.appels.some((a) => a.chemin.includes("prompt_async")));

    const accord = clientFactice([200, 204]);
    const ok = await libActivation.activerPuisEnvoyer(accord, { rootId: "ses_1", directory: "/workspace/p", plafondUsd: "0.10", texte: "x", model });
    assert.equal(ok.envoye, true);
    assert.match(accord.appels[1]?.chemin ?? "", /^\/api\/omo\/oc\/session\/ses_1\/prompt_async\?directory=%2Fworkspace%2Fp$/);
    assert.deepEqual((accord.appels[1]?.corps as { model?: unknown }).model, model, "l'envoi porte l'IA explicite qu'exige enforceTurn");
    assert.equal(accord.appels[1]?.entetes["x-cockpit-confirm"], "1");
  });

  it("un envoi SANS IA est refusé ici, avant tout appel (le proxy répondrait 400 « modele-requis »)", async () => {
    const client = clientFactice([]);
    for (const model of [undefined, {}, { providerID: "github-copilot" }, { providerID: "", modelID: "x" }]) {
      await assert.rejects(libActivation.envoyer(client, "ses_1", "/workspace/p", "x", { model }), /model \{providerID, modelID\} obligatoire/);
    }
    assert.equal(client.appels.length, 0);
  });

  it("409 « assistant-model-changed » : UN renvoi avec l'IA de l'assistant, jamais deux", async () => {
    const reponses = [
      { code: 409, corps: JSON.stringify({ error: "assistant-model-changed", model: { providerID: "github-copilot", modelID: "ia-assistant" }, variant: "haut" }) },
      { code: 409, corps: JSON.stringify({ error: "assistant-model-changed", model: { providerID: "github-copilot", modelID: "autre" }, variant: null }) },
    ];
    const appels: { corps: unknown }[] = [];
    const client: ClientFactice = {
      async brut(_m, _c, corps) {
        appels.push({ corps });
        return reponses.shift() ?? { code: 204, corps: "" };
      },
    };
    const r = (await libActivation.envoyer(client, "ses_1", "/workspace/p", "x", { model: { providerID: "github-copilot", modelID: "faux-m1" } })) as { code: number; renvoye?: boolean };
    assert.equal(appels.length, 2, "un seul renvoi, même si le second répond encore 409");
    assert.deepEqual(appels[1]?.corps, { parts: [{ type: "text", text: "x" }], model: { providerID: "github-copilot", modelID: "ia-assistant" }, variant: "haut" });
    assert.equal(r.code, 409);
    assert.equal(r.renvoye, true);
  });

  it("l'IA de l'envoi est prise dans le catalogue que la salle sert, jamais devinée", () => {
    const providers = { providers: [{ id: "banc", models: { "banc-1": {} } }, { id: "github-copilot", models: { "faux-m2": {}, "faux-m1": {} } }] };
    assert.deepEqual(libActivation.modeleDeLaSalle(providers), { providerID: "github-copilot", modelID: "faux-m1" });
    assert.deepEqual(libActivation.modeleDeLaSalle(providers, "absente"), { providerID: "github-copilot", modelID: "faux-m1" }, "sinon la première dans l'ordre des noms");
    assert.equal(libActivation.modeleDeLaSalle({ providers: [{ id: "banc", models: { x: {} } }] }), null, "aucune IA Copilot : aucun envoi");
    assert.equal(libActivation.modeleDeLaSalle(null), null);
  });
});

describe("L21b, lib-arret : silence, repos, relance à neuf et empreintes", () => {
  const releve = (at: number, requetes: Record<string, number>, types: Record<string, number>, fournisseur: number): Releve => ({
    at,
    espion: { requetes, flux: [{ n: 1, chemin: "/global/event", ouvert: true, evenements: 0, types }] },
    fournisseur,
  });

  it("écart d'activité : zéro partout = silence ; une commande, un envoi ou un appel au faux rompent le silence", () => {
    const avant = releve(0, { commande: 0, envoi: 2 }, { "message.updated": 3 }, 5);
    assert.equal(libArret.silence(libArret.ecartActivite(avant, releve(1000, { commande: 0, envoi: 2 }, { "message.updated": 3 }, 5))), true);
    assert.equal(libArret.silence(libArret.ecartActivite(avant, releve(1000, { commande: 1, envoi: 2 }, { "message.updated": 3 }, 5))), false);
    assert.equal(libArret.silence(libArret.ecartActivite(avant, releve(1000, { commande: 0, envoi: 2 }, { "message.updated": 4 }, 5))), false);
    assert.equal(libArret.silence(libArret.ecartActivite(avant, releve(1000, { commande: 0, envoi: 2 }, { "message.updated": 3 }, 6))), false);
    const e = libArret.ecartActivite(avant, releve(1000, { commande: 0, envoi: 3 }, { "message.updated": 3, "session.created": 1 }, 7));
    assert.equal(e.envois, 1);
    assert.equal(e.sessionsCreees, 1);
    assert.equal(e.appelsFournisseur, 2);
  });

  it("occupation : tout ce qui n'est pas « idle » est occupé, et l'illisible aussi", () => {
    assert.equal(libArret.occupee({}), false);
    assert.equal(libArret.occupee({ a: { type: "idle" } }), false);
    assert.equal(libArret.occupee({ a: { type: "busy" } }), true);
    assert.equal(libArret.occupee(null), true);
    assert.equal(libArret.occupee([]), true);
  });

  it("empreintes : ajout, retrait et modification relevés, racine par racine", () => {
    const e = libArret.comparerEmpreintes({ "/r": { a: "f:1", b: "f:2" } }, { "/r": { a: "f:1", b: "f:3", c: "d" } });
    assert.deepEqual(e, [
      { racine: "/r", chemin: "b", ecart: "modifie" },
      { racine: "/r", chemin: "c", ecart: "ajoute" },
    ]);
    assert.deepEqual(libArret.comparerEmpreintes({ "/r": { a: "f:1" } }, { "/r": { a: "f:1" } }), []);
  });

  it("relance à neuf : attendue sur un startId NOUVEAU dans la phase voulue, jamais sur l'ancien", async () => {
    const etats = [{ startId: "a", phase: "opencode-lance" }, { startId: "b", phase: "verification" }, { startId: "b", phase: "opencode-lance" }];
    let i = 0;
    const r = await libArret.attendreNouveauDemarrage(() => etats[Math.min(i++, etats.length - 1)], "a", { delaiMs: 5000, pasMs: 1 });
    assert.deepEqual({ ok: r.ok, startId: r.startId }, { ok: true, startId: "b" });
    const jamais = await libArret.attendreNouveauDemarrage(() => ({ startId: "a", phase: "opencode-lance" }), "a", { delaiMs: 30, pasMs: 5 });
    assert.equal(jamais.ok, false);
    const panne = await libArret.attendreNouveauDemarrage(() => {
      throw new Error("illisible");
    }, "a", { delaiMs: 20, pasMs: 5 });
    assert.equal(panne.ok, false, "un état illisible n'est pas une relance");
  });
});

// --- 5. Bibliothèque de scénarios du faux fournisseur -----------------------------------------------------------------------------

describe("L21b, scénarios du faux fournisseur : chaque série est ACCEPTÉE par le vrai faux (L21a)", () => {
  it("lecture, recherche, motif, liste, commande, task, call_omo_agent, skill_mcp, skill, 429, réponse lente, 30 sessions, hooks", { timeout: 60_000 }, async (t) => {
    const JETON = "jeton-du-test-l21b-32-signes-au-moins";
    const enfant = spawn(process.execPath, [path.join(BANC, "lib", "faux-copilot.mjs"), "--http", "--port", "0", "--pilot-port", "0"], {
      env: { ...process.env, FAUX_COPILOT_JETON_PILOTE: JETON },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sortie = "";
    enfant.stdout.on("data", (b: Buffer) => {
      sortie += b;
    });
    t.after(async () => {
      enfant.kill();
      await once(enfant, "close").catch(() => undefined);
    });
    const annonce = await until(() => sortie.split("\n").map((l) => (l.trim() === "" ? null : (JSON.parse(l) as { pret?: boolean; pilote?: { port: number } }))).find((x) => x?.pret === true), 10_000);
    const pilote = annonce?.pilote?.port ?? 0;
    const poster = async (reponses: unknown[]) => {
      await demander(pilote, "POST", "/reinitialiser", "{}", { "x-pilote-jeton": JETON });
      return demander(pilote, "POST", "/reponses", JSON.stringify({ reponses }), { "x-pilote-jeton": JETON });
    };
    const D = "/workspace/projet-ouvert";
    const series: [string, unknown[]][] = [
      ["un outil puis la fin", faux.unOutilPuisFin(faux.lecture(`${D}/LISEZMOI.md`))],
      ["read, grep, glob, list, bash", [faux.appels(faux.lecture(`${D}/a`), faux.recherche("x", D), faux.motif("**/*.md", D), faux.liste(D), faux.commande("git status"))]],
      ["task (agent, catégorie, fond)", [faux.appels(faux.tache(), faux.tacheParCategorie(), faux.tache({ enFond: true }))]],
      ["call_omo_agent, skill_mcp, skill", [faux.appels(faux.appelAgent(), faux.outilMcp(), faux.competence("aide-piegee"))]],
      ["trois 429", faux.serie429(3)],
      ["réponse lente", [faux.lente(20_000)]],
      ["30 sessions (31 créées)", faux.trenteSessions()],
      ["hooks : liste de tâches", faux.todoInachevee()],
      ["hooks : prometheus", faux.prometheusEcrit(D)],
      ["hooks : atlas", faux.atlasEcritDirect(D)],
    ];
    for (const [nom, reponses] of series) {
      const r = await poster(reponses);
      assert.equal(r.statut, 200, `${nom} refusé par le faux : ${r.corps}`);
    }
    // Contre-épreuve : le faux refuse bien une réponse hors format (sinon « accepté » ne prouverait rien).
    assert.equal((await poster([{ texte: "x", inconnue: 1 }])).statut, 400);
  });

  it("les bornes du faux sont tenues ICI, avant tout envoi", () => {
    assert.throws(() => faux.outil("Nom Faux"), /nom d'outil refusé/);
    assert.throws(() => faux.appels(), /de 1 à/);
    assert.throws(() => faux.serie429(0), /hors bornes/);
    assert.throws(() => faux.lente(faux.BORNES_FAUX.delaiMaxMs + 1), /hors bornes/);
    assert.throws(() => faux.sessions(101), /hors bornes/);
    assert.equal(faux.trenteSessions().length <= faux.BORNES_FAUX.file, true);
  });

  it("directives marquées : même motif que la détection 2 du cockpit, les sept types de la 4.19.4, jamais le texte", () => {
    const origine = fs.readFileSync(path.join(RACINE, "app", "server", "shared", "message-origin.ts"), "utf8");
    const cockpit = /const SYSTEM_DIRECTIVE_RE = \/\^(.+)\/;/.exec(origine)?.[1];
    assert.ok(cockpit !== undefined, "motif de la détection 2 introuvable");
    assert.equal(faux.MOTIF_DIRECTIVE.source, cockpit, "le banc cherche exactement ce que le cockpit reconnaît");
    assert.equal(faux.DIRECTIVES_MARQUEES.length, 7);
    const texte = "debut [SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION] milieu [SYSTEM DIRECTIVE: OH-MY-OPENCODE - PROMETHEUS READ-ONLY] fin";
    assert.deepEqual(faux.directivesDe(texte), ["TODO CONTINUATION", "PROMETHEUS READ-ONLY"]);
    assert.deepEqual(faux.directivesDe(texte), ["TODO CONTINUATION", "PROMETHEUS READ-ONLY"], "motif global rejoué sans état");
    assert.deepEqual(faux.directivesDe("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - minuscules]"), []);
  });
});

// --- 6. M28 : répondeur du banc et agents -----------------------------------------------------------------------------------------

describe("L21b, M28 (R-7) : le répondeur du banc n'accorde que l'écriture dans le projet jetable ouvert", () => {
  it("« once » pour edit/write sous le projet ouvert ; « reject » pour tout le reste", () => {
    const d = hooks.decisionRepondeurBanc;
    assert.equal(d({ permission: "edit", patterns: ["/workspace/projet-ouvert/docs/banc-plan.md"] }), "once");
    assert.equal(d({ permission: "write", patterns: ["docs/banc.md"] }), "once");
    assert.equal(d({ permission: "bash", patterns: ["git status"] }), "reject");
    assert.equal(d({ permission: "edit", patterns: ["/workspace/projet-temoin/notes.txt"] }), "reject", "jamais un autre projet");
    assert.equal(d({ permission: "edit", patterns: ["/workspace/projet-ouvert/../projet-temoin/x"] }), "reject");
    assert.equal(d({ permission: "edit", patterns: ["/etc/passwd"] }), "reject");
    assert.equal(d({ permission: "edit", patterns: ["~/.ssh/config"] }), "reject");
    assert.equal(d({ permission: "edit", patterns: [] }), "reject", "rien à juger : refus");
    assert.equal(d({ permission: "external_directory", patterns: ["/workspace/projet-ouvert/x"] }), "reject");
    assert.equal(d({ permission: "edit", patterns: ["/workspace/projet-ouvert/a", "/tmp/b"] }), "reject", "TOUS les motifs doivent être dans le projet");
    assert.equal(d(null), "reject");
  });

  it("relevé sans contenu : journal de l'extension compté par automatisme, conversation stockée comptée par outil et état", () => {
    const journal = [
      "[2026-09-24] [atlas] Injected delegation warning for direct file modification {\"sessionID\":\"ses_x\",\"filePath\":\"/workspace/projet-ouvert/docs/secret.md\"}",
      "[2026-09-24] [todo-continuation-enforcer] countdown started",
      "[2026-09-24] [autre] rien",
      "texte [SYSTEM DIRECTIVE: OH-MY-OPENCODE - DELEGATION REQUIRED] suite",
    ].join("\n");
    const t = hooks.tracesAutomatismes(`${journal}\n[t] [atlas] Wrote /workspace/projet-ouvert/x.md {"a":1}\n[t] [atlas] session 12345678 {}`);
    assert.deepEqual(t, {
      lignes: 6,
      parNom: { "todo-continuation-enforcer": 1, "prometheus-md-only": 0, atlas: 3 },
      phrases: { "todo-continuation-enforcer": ["countdown started"], "prometheus-md-only": [], atlas: ["Injected delegation warning for direct file modification"] },
      directives: ["DELEGATION REQUIRED"],
    });
    assert.ok(!JSON.stringify(t).includes("secret.md"), "jamais une ligne ni un chemin");
    assert.ok(!JSON.stringify(t).includes("12345678"), "jamais une donnée chiffrée de la session");
    const messages = [
      { parts: [{ type: "text", text: "consigne" }, { type: "tool", tool: "write", state: { status: "completed", output: "ok [SYSTEM DIRECTIVE: OH-MY-OPENCODE - DELEGATION REQUIRED]" } }] },
      { parts: [{ type: "tool", tool: "todowrite", state: { status: "error" } }, { type: "tool", tool: "write", state: { status: "completed" } }] },
    ];
    const s = hooks.releveStocke(messages);
    assert.deepEqual(s, { messages: 2, outils: { "write:completed": 2, "todowrite:error": 1 }, directives: ["DELEGATION REQUIRED"] });
    assert.ok(!JSON.stringify(s).includes("consigne"));
    assert.deepEqual(hooks.releveStocke(null), { messages: 0, outils: {}, directives: [] });
  });

  it("agents résolus par leur clé dans GET /agent (nom d'affichage de l'extension)", () => {
    const agents = [{ name: "Atlas - Plan Executor" }, { name: "Prometheus - Plan Builder" }, { name: "build" }, { name: "Sisyphus-Junior" }];
    assert.equal(hooks.nomAgentPourCle(agents, "prometheus"), "Prometheus - Plan Builder");
    assert.equal(hooks.nomAgentPourCle(agents, "atlas"), "Atlas - Plan Executor");
    assert.equal(hooks.nomAgentPourCle(agents, "build"), "build");
    assert.equal(hooks.nomAgentPourCle(agents, "sisyphus-junior"), "Sisyphus-Junior");
    assert.equal(hooks.nomAgentPourCle(agents, "oracle"), null, "absent : null, jamais l'agent par défaut");
    assert.equal(hooks.nomAgentPourCle(null, "build"), null);
  });
});

// --- 7. R-2 : lien M22 ---------------------------------------------------------------------------------------------------------------

describe("L21b, R-2 : le relevé M22 du banc est relié AUTOMATIQUEMENT aux constantes d'omo-compose.test.ts", () => {
  const source = fs.readFileSync(path.join(RACINE, ...lienM22.FICHIER_CONSTANTES_M22.split("/")), "utf8");

  it("les trois constantes sont lues dans le VRAI fichier (un renommage rompt le lien, et le dit)", () => {
    const c = lienM22.constantesM22(source);
    assert.ok(c !== null, "MEM_MAX_MIO, PIDS_MAX ou M22_MEM_RELEVE_MAX_PUBLIE introuvable : le lien du banc est rompu");
    assert.ok(c.memMaxMio >= c.releveMaxPublie, "garde-fou de S3 (6385c92) toujours vrai");
    assert.equal(lienM22.constantesM22(source.replace("const MEM_MAX_MIO =", "const MEMOIRE_MAX =")), null);
  });

  it("relevé sous les constantes : vert ; au-dessus : rouge, avec la ligne à corriger ; absent ou illisible : rouge", () => {
    const c = lienM22.constantesM22(source);
    assert.ok(c !== null);
    assert.equal(lienM22.jugerLienM22({ memoireMioMax: c.memMaxMio, pidsMax: c.pidsMax }, c).ok, true);
    const haut = lienM22.jugerLienM22({ memoireMioMax: c.memMaxMio + 0.1, pidsMax: c.pidsMax }, c);
    assert.equal(haut.ok, false);
    assert.match(haut.points.find((p) => !p.ok)?.detail ?? "", /remonter MEM_MAX_MIO ET M22_MEM_RELEVE_MAX_PUBLIE/);
    assert.equal(lienM22.jugerLienM22({ memoireMioMax: 1, pidsMax: c.pidsMax + 1 }, c).ok, false);
    assert.equal(lienM22.jugerLienM22(undefined, c).ok, false);
    assert.equal(lienM22.jugerLienM22({ memoireMioMax: "547", pidsMax: 1 }, c).ok, false);
    assert.equal(lienM22.jugerLienM22({ memoireMioMax: 1, pidsMax: 1 }, null).ok, false);
  });

  it("le banc applique le lien après G1 et écrit g1-stats.json", () => {
    const banc = fs.readFileSync(path.join(BANC, "run-banc.mjs"), "utf8");
    assert.match(banc, /jugerLienM22\(bilan\.mesures\.M22, constantesM22\(source\)\)/);
    assert.match(lireBanc("scenarios/g1-reseau.mjs"), /ecrireSortie\("g1-stats\.json"/);
  });
});

// --- 8. Projets de test G7 et G13 ----------------------------------------------------------------------------------------------------

describe("L21b, projets de test G7 et G13 : synthétiques, inertes, sans secret", () => {
  const fichiers = (racine: string): string[] =>
    fs.readdirSync(racine, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? fichiers(path.join(racine, e.name)) : [path.join(racine, e.name)]));
  const tous = fichiers(path.join(BANC, "projets"));

  it("les pièges attendus sont là : compétence piégée, fichier d'IDE, programme G13", () => {
    const rel = tous.map((f) => path.relative(path.join(BANC, "projets"), f).split(path.sep).join("/")).sort();
    for (const attendu of ["g13/src/lire-environ.mjs", "g7/.agents/skills/aide-piegee/SKILL.md", "g7/.vscode/tasks.json", "g7/src/app.js"]) assert.ok(rel.includes(attendu), attendu);
    JSON.parse(fs.readFileSync(path.join(BANC, "projets", "g7", ".vscode", "tasks.json"), "utf8"));
  });

  it("analyse de secrets des fixtures : aucune forme de jeton, de clé ni de mot de passe", () => {
    const motifs = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_/, /\bsk-[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /(password|passwd|secret|token)\s*[:=]\s*["'][^"']{6,}/i, /xox[abpr]-/];
    for (const f of tous) {
      const texte = fs.readFileSync(f, "utf8");
      for (const m of motifs) assert.doesNotMatch(texte, m, `${path.relative(RACINE, f)} : ${m}`);
    }
  });

  it("le programme G13 est inerte : aucune adresse de sortie, seulement la boucle locale ; il ne rend que des noms et un compte", () => {
    const g13 = fs.readFileSync(path.join(BANC, "projets", "g13", "src", "lire-environ.mjs"), "utf8");
    const urls = [...g13.matchAll(/https?:\/\/([^/"'`\s]+)/g)].map((m) => m[1]);
    assert.deepEqual(urls, ["127.0.0.1:4096"]);
    assert.doesNotMatch(g13, /writeFile|appendFile|createWriteStream|child_process/);
    assert.match(g13, /split\("=", 1\)\[0\]/, "seulement les NOMS des variables, jamais une valeur");
  });
});

// --- 9. Mode à blanc, aide et README (R-3, R-9) --------------------------------------------------------------------------------------

describe("L21b, mode à blanc du banc complet ; aide et README : deux exécutions obligatoires, lancement détaché", () => {
  it("à blanc, complet : rend 0, n'appelle jamais docker, vérifie le refus d'une référence-option et dit ce que la tête livre", { timeout: 60_000 }, async () => {
    const { code, sortie } = await lancerBanc(["--a-blanc", "--complet", "--battement-banc", "--projets-test", "g7,g13"]);
    assert.equal(code, 0, sortie.slice(-800));
    assert.match(sortie, /\[à blanc\] VERT/);
    assert.match(sortie, /9\/9 refus vérifiés/);
    assert.match(sortie, /référence « --output=\/tmp\/x » pour le cockpit réel : référence refusée/);
    assert.match(sortie, /cette tête livre : bascule de SALLE_OUVERTE possible \(1 occurrence/);
    assert.match(sortie, /portes : cockpit-fumee/);
    assert.doesNotMatch(sortie, /ENOENT|spawn docker/);
  });

  it("à blanc : une référence-option demandée, un projet de test inconnu → refus, rien de lancé", { timeout: 60_000 }, async () => {
    const ref = await lancerBanc(["--a-blanc", "--complet", "--ref=--output=x"]);
    assert.equal(ref.code, 1);
    assert.match(ref.sortie, /\[à blanc\] ROUGE/);
    const projet = await lancerBanc(["--a-blanc", "--projets-test", "inconnu"]);
    assert.notEqual(projet.code, 0);
    assert.match(projet.sortie, /--projets-test : « inconnu » inconnu/);
  });

  it("l'aide dit les DEUX exécutions obligatoires (R-3, à jour de L16c) et le lancement détaché (R-9)", { timeout: 60_000 }, async () => {
    const { code, sortie } = await lancerBanc(["--aide"]);
    assert.equal(code, 0);
    assert.match(sortie, /DEUX EXÉCUTIONS SONT OBLIGATOIRES/);
    assert.match(sortie, /banc HORS LIGNE avec de vrais dépôts/);
    assert.match(sortie, /banc COMPLET \(--complet\)/);
    assert.match(sortie, /--sans-git ne sert qu'au diagnostic/);
    assert.match(sortie, /LANCEMENT DÉTACHÉ OBLIGATOIRE/);
    assert.match(sortie, /Start-Process/);
  });

  it("le README du banc dit la même chose, avec la commande de lancement détaché", () => {
    const readme = lireBanc("README.md");
    assert.match(readme, /### 2\.1 Deux exécutions obligatoires/);
    assert.match(readme, /### 2\.2 Lancement détaché obligatoire/);
    assert.match(readme, /Start-Process -FilePath node/);
    assert.match(readme, /--battement-banc/);
    assert.match(readme, /startHeartbeat\(\)/);
    assert.match(readme, /lien M22/i);
  });

  it("la fumée hors du mode complet est SANS OBJET, jamais verte ni rouge", async () => {
    const r = await fumee.default.executer({});
    assert.match(r.sansObjet ?? "", /hors du mode --complet/);
    assert.equal(fumee.PLAFOND_FUMEE, "0.10");
  });
});
