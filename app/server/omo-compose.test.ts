// Tests L16b : compose de la salle et `app/Dockerfile` (T-L16-e étendu, T-L15-d ; spéc. §3.15.2 l.497-505, l.518-522, P13 l.48 ;
// plan D-2b-26, D-2b-33 révisée, D-2b-46 ; mesures MX-OMO MO-2, MO-3, MO-4, MO-7, MO-10, MO-11).
//
// Le fichier `docker-compose.yml` est lu avec le paquet `yaml` du cockpit (le même analyseur que `wiring-11.test.ts`) et
// `app/Dockerfile` comme du texte : rien n'est construit, aucun démon Docker n'est appelé. Le contrat machine
// `docker/opencode-omo/contrat-salle.json` est la référence : services, réseau, volumes (cible, mode, propriétaire, écrivain),
// liste blanche des variables et options de sécurité. Une règle qui n'est pas dans le contrat est écrite ici avec sa mesure.
//
// - §1 services de la salle : profil, image sans `:?`, `pull_policy: never`, aucun `build` ;
// - §2 durcissement d'`opencode-omo` : `read_only`, tmpfs du contrat en syntaxe courte, capacités, `no-new-privileges`, limites ;
// - §3 montages : égalité avec le contrat, cinq dossiers du HOME en `:ro` depuis `omo-config`, `oc-data` jamais monté ;
// - §4 environnement : ⊆ liste blanche, aucun `env_file`, aucune ancre `network-env`, sortie par `egress`, adresse Copilot ;
// - §5 réseaux : `omo-internal` fermé, membres comptés un par un, `opencode` jamais dedans ;
// - §6 `egress` : commande, sonde propre, durcissement, deux réseaux ;
// - §7 cockpit : variables de la salle, montages, `NO_PROXY`, aucun `depends_on` vers un service à profil ;
// - §8 `app/Dockerfile` : points de montage créés et donnés à `node`, `/omo-state` laissé à root, image du cockpit inchangée ;
// - §9 `omo-init` (MO-11) et §10 `.dockerignore` / `.gitignore`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { OMO_SALLE_CONTRACT_FILE } from "./omo-contracts.ts";
import type { OmoSalleContract } from "./shared/omo-types.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");
const COMPOSE_FICHIER = path.join(RACINE, "docker-compose.yml");
const DOCKERFILE_APP = path.join(RACINE, "app", "Dockerfile");

const TEXTE_COMPOSE = fs.readFileSync(COMPOSE_FICHIER, "utf8");
const TEXTE_DOCKERFILE = fs.readFileSync(DOCKERFILE_APP, "utf8");
const TEXTE_INSTALL = fs.readFileSync(path.join(RACINE, "install.ps1"), "utf8");
/** Surcharge générée par install.ps1 (L15c) : elle porte les binds `.git:ro` et la source de la liste des projets préparés. */
const SURCHARGE_PROJETS = "docker-compose.omo-projets.yml";
const CONTRAT = JSON.parse(fs.readFileSync(path.join(RACINE, OMO_SALLE_CONTRACT_FILE), "utf8")) as OmoSalleContract;

/** Service jetable qui pose le propriétaire des volumes de la salle (MO-11) : hors contrat, décrit ici. */
const SERVICE_INIT = "omo-init";
/** Dossier d'état d'opencode, rendu inscriptible par un tmpfs de plus (MO-3 point 8) : hors contrat, décrit ici. */
const TMPFS_ETAT = "/home/node/.local/state:exec,mode=0755,uid=1000,gid=1000";

interface ServiceCompose {
  profiles?: string[];
  image?: string;
  build?: unknown;
  pull_policy?: string;
  read_only?: boolean;
  tmpfs?: string[];
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  pids_limit?: number;
  cpus?: number | string;
  mem_limit?: string;
  restart?: string;
  command?: string[];
  entrypoint?: string[];
  user?: string;
  healthcheck?: { test?: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string };
  environment?: Record<string, string>;
  env_file?: unknown;
  volumes?: string[];
  networks?: string[];
  network_mode?: string;
  depends_on?: Record<string, { condition?: string }>;
  expose?: string[];
  logging?: unknown;
  init?: boolean;
  ports?: string[];
}

interface Compose {
  name: string;
  services: Record<string, ServiceCompose>;
  volumes: Record<string, unknown>;
  networks: Record<string, { internal?: boolean } | null>;
}

const COMPOSE = parseYaml(TEXTE_COMPOSE) as Compose;

const SALLE = CONTRAT.services.salle;
const EGRESS = CONTRAT.services.egress;
const COCKPIT = CONTRAT.services.cockpit;
const PRINCIPALE = CONTRAT.services.principale;

/** Service du compose, avec un message clair s'il manque. */
function service(nom: string): ServiceCompose {
  const trouve = COMPOSE.services[nom];
  assert.ok(trouve !== undefined, `service ${nom} absent de docker-compose.yml`);
  return trouve;
}

/**
 * Découpe un montage de la syntaxe courte (`source:cible[:mode]`). Les `:` d'une interpolation (`${ARCHIVE_DIR:-./archives}`) ne
 * séparent rien : les ignorer est indispensable pour lire le fichier tel qu'il est écrit.
 */
export function decouperMontage(brut: string): { source: string; cible: string; mode: string } {
  const morceaux: string[] = [];
  let courant = "";
  let profondeur = 0;
  for (let k = 0; k < brut.length; k += 1) {
    const c = brut[k];
    if (c === "$" && brut[k + 1] === "{") profondeur += 1;
    else if (c === "}" && profondeur > 0) profondeur -= 1;
    if (c === ":" && profondeur === 0) {
      morceaux.push(courant);
      courant = "";
      continue;
    }
    courant += c;
  }
  morceaux.push(courant);
  assert.ok(morceaux.length === 2 || morceaux.length === 3, `montage illisible : ${brut}`);
  return { source: morceaux[0] ?? "", cible: morceaux[1] ?? "", mode: morceaux[2] ?? "rw" };
}

/** Montages d'un service, décodés. */
function montages(nom: string) {
  return (service(nom).volumes ?? []).map(decouperMontage);
}

/** Montages d'un service qui viennent d'un volume nommé du contrat. */
function montagesDeVolume(nom: string) {
  const nomsContrat = new Set(CONTRAT.volumes.map((v) => v.nom));
  return montages(nom).filter((m) => nomsContrat.has(m.source));
}

/** Nom de service du compose pour une clé de service du contrat. */
function serviceDuContrat(cle: "salle" | "egress" | "cockpit" | "principale"): string {
  return CONTRAT.services[cle];
}

/** Réseaux d'un service : la clé absente vaut `default` seul (comportement de Compose). */
function reseaux(nom: string): string[] {
  const s = service(nom);
  if (s.network_mode !== undefined) return [];
  return s.networks ?? ["default"];
}

/** Instructions logiques d'un Dockerfile : continuations `\` recollées, commentaires et lignes vides retirés. */
export function instructionsDockerfile(texte: string): string[] {
  const instructions: string[] = [];
  let courante = "";
  for (const brute of texte.split("\n")) {
    const ligne = brute.replace(/\r$/, "");
    if (courante === "" && (ligne.trim() === "" || ligne.trim().startsWith("#"))) continue;
    if (ligne.trimEnd().endsWith("\\")) {
      courante += `${ligne.trimEnd().slice(0, -1)} `;
      continue;
    }
    instructions.push(`${courante}${ligne}`.replace(/\s+/g, " ").trim());
    courante = "";
  }
  if (courante !== "") instructions.push(courante.replace(/\s+/g, " ").trim());
  return instructions;
}

const INSTRUCTIONS_DOCKERFILE = instructionsDockerfile(TEXTE_DOCKERFILE);
const RUN_DOCKERFILE = INSTRUCTIONS_DOCKERFILE.filter((i) => i.startsWith("RUN "));

/** Mots d'une instruction du Dockerfile qui suivent une commande donnée, jusqu'au prochain séparateur `;` ou `&&`. */
function argumentsDe(instruction: string, commande: string): string[][] {
  const trouves: string[][] = [];
  for (const morceau of instruction.split(/;|&&/)) {
    const mots = morceau.trim().replace(/^[A-Z]+\s+/, "").split(/\s+/);
    if (mots[0] !== commande) continue;
    trouves.push(mots.slice(1).filter((mot) => !mot.startsWith("-")));
  }
  return trouves;
}

// --- §1 Services de la salle : profil, image, aucune construction -----------------------------------------------------------

describe("L16b §1 : les services de la salle sont derrière le profil, sans construction ni tirage d'image", () => {
  it("opencode-omo, egress et omo-init portent exactement le profil du contrat ; aucun autre service n'en a", () => {
    const attendus = [SALLE, EGRESS, SERVICE_INIT].sort();
    const aProfil = Object.entries(COMPOSE.services)
      .filter(([, s]) => (s.profiles ?? []).length > 0)
      .map(([nom]) => nom)
      .sort();
    assert.deepEqual(aProfil, attendus);
    for (const nom of attendus) assert.deepEqual(service(nom).profiles, [CONTRAT.profil], nom);
  });

  it("T-L15-d (P13) : l'image de la salle a un défaut inoffensif, `pull_policy: never`, et aucun `build`", () => {
    const salle = service(SALLE);
    // MO-3 point 1 : `${COCKPIT_OMO_IMAGE:?}` casserait `config`, `up`, `stop` et `down` du projet entier, profil inactif compris.
    assert.match(String(salle.image), /^\$\{COCKPIT_OMO_IMAGE:-[a-z0-9./-]+:[a-z0-9.-]+\}$/);
    assert.equal(salle.pull_policy, "never");
    assert.equal(salle.build, undefined, "l'image de la salle n'est jamais construite ici (P13)");
    // Le service `egress` emprunte l'image du cockpit : lui donner un `build` la reconstruirait une seconde fois.
    assert.equal(service(EGRESS).build, undefined);
    assert.equal(service(EGRESS).image, service(COCKPIT).image);
    assert.equal(service(SERVICE_INIT).image, service(COCKPIT).image);
  });

  it("aucune variable exigée (`${…:?…}`) dans un service à profil, ni dans les volumes et réseaux", () => {
    const exigee = /\$\{[A-Za-z_][A-Za-z0-9_]*:\?/;
    for (const nom of [SALLE, EGRESS, SERVICE_INIT]) {
      assert.doesNotMatch(JSON.stringify(service(nom)), exigee, nom);
    }
    assert.doesNotMatch(JSON.stringify(COMPOSE.volumes), exigee);
    assert.doesNotMatch(JSON.stringify(COMPOSE.networks), exigee);
    // Les seules variables exigées du fichier restent celles des deux services de base, toujours actifs (1.0.5).
    const parService = Object.entries(COMPOSE.services)
      .filter(([, s]) => exigee.test(JSON.stringify(s)))
      .map(([nom]) => nom)
      .sort();
    assert.deepEqual(parService, [COCKPIT, PRINCIPALE].sort());
  });

  it("le compose dit, d'une seule phrase, de répéter le profil pour `stop` et `down` (MO-3 point 2)", () => {
    const entete = TEXTE_COMPOSE.slice(0, TEXTE_COMPOSE.indexOf("name: opencode-cockpit"));
    // Une règle éparpillée sur plusieurs points ne se lit pas : les trois mots doivent tenir dans la même règle numérotée.
    const regles = entete.split(/#\s+\d\.\s/).slice(1);
    assert.ok(regles.length >= 3, "règles numérotées attendues dans l'en-tête");
    const complete = regles.filter((regle) => regle.includes("--profile omo") && regle.includes("stop") && regle.includes("down"));
    assert.equal(complete.length, 1, "une règle, et une seule, doit lier le profil à `stop` et à `down`");
  });
});

// --- §2 Durcissement d'opencode-omo -----------------------------------------------------------------------------------------

describe("L16b §2 : durcissement d'opencode-omo (contrat `securite`, MO-4, MO-7, D-2b-46)", () => {
  const salle = service(SALLE);
  /**
   * ÉCHANTILLON, PAS UNE BORNE. Plus haut relevé de la mesure M22 du banc hors ligne (L21), extension 4.19.4 chargée, PENDANT
   * la charge de la porte G1 : 547,2 Mio au maximum (moyenne 520), 29 processus, sur 58 relevés `docker stats` pendant les
   * 171 passes des 30 minutes du rejeu de la revue d'itération 2 bis.
   *
   * Ce n'est PAS un plafond que le produit tiendrait : rien ne l'impose au conteneur, et la mesure DÉRIVE d'une exécution à
   * l'autre. La preuve est dans l'histoire de cette même ligne : 347,8 Mio (relevé au repos, qui sous-mesurait d'un tiers),
   * puis 516,7 Mio (40 relevés, répétition générale), puis 547,2 Mio (58 relevés, rejeu) — soit + 5,9 % pour la même charge.
   * La valeur ne sert donc qu'à une chose : refuser un plafond du compose qui descendrait sous deux fois ce qu'on a DÉJÀ vu
   * passer. Une remesure plus haute remonte cette ligne (et, s'il le faut, les plafonds du compose) ; jamais les facteurs de
   * marge, qui sont, eux, la règle.
   */
  const MEM_MAX_MIO = 547.2;
  const PIDS_MAX = 29;

  /**
   * Plus haut relevé PUBLIÉ par un banc, gardé à part de la constante pour que la garde ci-dessous ne puisse pas être satisfaite
   * en baissant les deux ensemble. À remonter avec MEM_MAX_MIO quand un banc publie plus haut, jamais à baisser.
   */
  const M22_MEM_RELEVE_MAX_PUBLIE = 547.2;

  /** `mem_limit` du compose en mébioctets : suffixe k/m/g, ou des octets sans suffixe. */
  const memLimitMio = (valeur: unknown): number => {
    const lu = /^(\d+)([kmg]?)$/i.exec(String(valeur));
    assert.ok(lu, `mem_limit illisible : ${String(valeur)}`);
    const facteurs: Record<string, number> = { "": 1 / (1024 * 1024), k: 1 / 1024, m: 1, g: 1024 };
    return Number(lu[1]) * (facteurs[(lu[2] ?? "").toLowerCase()] as number);
  };

  it("racine en lecture seule, capacités et no-new-privileges exactement ceux du contrat", () => {
    assert.equal(salle.read_only, CONTRAT.securite.read_only);
    assert.deepEqual(salle.cap_drop, CONTRAT.securite.cap_drop);
    assert.deepEqual(salle.cap_add, CONTRAT.securite.cap_add);
    assert.deepEqual(salle.security_opt, CONTRAT.securite.security_opt);
  });

  it("tmpfs : les deux du contrat, en syntaxe courte, plus le dossier d'état d'opencode (MO-3 point 8, MO-4 point 3)", () => {
    // Syntaxe COURTE imposée : la syntaxe longue (`type: tmpfs`) n'accepte ni `exec`, ni `uid`/`gid` (MO-4 point 3).
    assert.ok(Array.isArray(salle.tmpfs), "tmpfs en syntaxe courte (liste de chaînes)");
    for (const entree of salle.tmpfs ?? []) assert.equal(typeof entree, "string");
    assert.deepEqual(salle.tmpfs, [...CONTRAT.securite.tmpfs, TMPFS_ETAT]);
    for (const entree of CONTRAT.securite.tmpfs) assert.match(entree, /[:,]exec(,|$)/, entree);
    // Sous le HOME, Docker crée les dossiers intermédiaires des montages en root 755 : sans ce tmpfs, `node` ne pourrait pas
    // créer ~/.local/state/opencode, et le dossier d'état d'opencode serait inaccessible.
    assert.match(TMPFS_ETAT, /^\/home\/node\/\.local\/state:.*uid=1000,gid=1000$/);
  });

  it("limites ajustées par la mesure M22 sous charge (D-2b-46) : pids_limit, cpus et mem_limit", () => {
    // Mesure M22 du banc hors ligne (L21), chiffres en tête du describe. Les plafonds sont descendus des valeurs provisoires
    // (512 / 2 / 4g) aux valeurs mesurées au repos (128 / 2 / 1g), puis remontés à ce que la charge réelle exige. Les trois
    // restent posés : un plafond absent laisserait la salle prendre toute la machine.
    assert.equal(salle.pids_limit, 256);
    assert.equal(salle.cpus, 2);
    assert.equal(salle.mem_limit, "2g");
    assert.match(String(salle.mem_limit), /^\d+[kmg]?$/i);
    assert.equal(salle.restart, "unless-stopped");
    // Marges LUES dans le compose, jamais recopiées : un resserrement sous le maximum mesuré fait tomber le test.
    assert.ok(memLimitMio(salle.mem_limit) >= MEM_MAX_MIO * 2, `la mémoire permise garde au moins deux fois le maximum mesuré (${String(salle.mem_limit)})`);
    assert.ok(salle.pids_limit >= PIDS_MAX * 5, `les processus permis gardent au moins cinq fois le maximum mesuré (${String(salle.pids_limit)})`);
  });

  it("MEM_MAX_MIO n'est jamais sous le plus haut relevé publié par un banc, et son commentaire dit que c'est un échantillon", () => {
    // Constat BAS de la revue d'itération 2 bis : la constante (516,7) était déjà dépassée par le rejeu (547,2, + 5,9 %) et son
    // commentaire la présentait comme « le maximum ». Elle est recopiée à la main depuis un rapport, contrairement aux plafonds
    // qui sont RELUS dans le compose : cette garde est le garde-fou de cette recopie.
    assert.ok(
      MEM_MAX_MIO >= M22_MEM_RELEVE_MAX_PUBLIE,
      `MEM_MAX_MIO = ${MEM_MAX_MIO} Mio est sous le plus haut relevé publié par un banc (${M22_MEM_RELEVE_MAX_PUBLIE} Mio) : la marge annoncée par ce describe n'est plus vraie`,
    );
    const source = fs.readFileSync(path.join(import.meta.dirname, "omo-compose.test.ts"), "utf8");
    assert.match(source, /ÉCHANTILLON, PAS UNE BORNE\./, "le commentaire de MEM_MAX_MIO doit dire que c'est un échantillon, pas une borne");
  });

  it("la mesure M22 est prise sous charge, jamais au repos : c'est la porte G1 qui la relève", () => {
    // La correction de la répétition générale : un relevé au repos sous-mesure d'un tiers la mémoire et de deux tiers les
    // processus. Le scénario `mesures` ne publie donc plus `M22` (son relevé devient `M22Repos`), et `g1-reseau` la publie
    // pendant ses 30 minutes de passes.
    const mesures = fs.readFileSync(path.join(RACINE, "e2e", "omo-banc", "scenarios", "mesures.mjs"), "utf8");
    const g1 = fs.readFileSync(path.join(RACINE, "e2e", "omo-banc", "scenarios", "g1-reseau.mjs"), "utf8");
    assert.match(mesures, /mesures\.M22Repos = \{/, "le relevé au repos se nomme M22Repos");
    assert.doesNotMatch(mesures, /mesures\.M22 = /, "le scénario des mesures ne publie plus M22");
    assert.match(g1, /mesures\.M22 = /, "g1-reseau publie M22");
    assert.match(g1, /releverStats\(ctx, `\$\{ctx\.projet\}-opencode-omo-1`\)/, "g1-reseau relève docker stats pendant ses passes");
    // Les deux lisent les plafonds dans le compose : aucune copie en dur, qui mentirait dès l'ajustement suivant.
    for (const [nom, texte] of [
      ["mesures.mjs", mesures],
      ["g1-reseau.mjs", g1],
    ] as const) {
      assert.match(texte, /plafondsActuels: plafondsDuCompose\(/, nom);
      assert.doesNotMatch(texte, /plafondsActuels: \{/, nom);
    }
  });

  it("aucun port publié : la salle n'est joignable que par le réseau fermé", () => {
    assert.equal(salle.ports, undefined);
    assert.deepEqual(salle.expose, ["4096"]);
  });
});

// --- §3 Montages ------------------------------------------------------------------------------------------------------------

describe("L16b §3 : montages exactement ceux du contrat (D-2b-26, D-2b-33 révisée)", () => {
  it("chaque montage de volume nommé du contrat est dans le compose, avec sa cible et son mode", () => {
    for (const volume of CONTRAT.volumes) {
      for (const montage of volume.montages) {
        const nomService = serviceDuContrat(montage.service);
        const trouve = montages(nomService).find((m) => m.source === volume.nom && m.cible === montage.cible);
        assert.ok(trouve !== undefined, `${volume.nom} → ${nomService}:${montage.cible} absent du compose`);
        assert.equal(trouve.mode, montage.mode, `${volume.nom} → ${nomService}:${montage.cible}`);
      }
    }
  });

  it("aucun montage de volume nommé en trop : la salle et egress ne montent que ce que le contrat prévoit", () => {
    for (const cle of ["salle", "egress"] as const) {
      const nomService = serviceDuContrat(cle);
      const attendus = CONTRAT.volumes
        .flatMap((v) => v.montages.filter((m) => m.service === cle).map((m) => `${v.nom}:${m.cible}:${m.mode}`))
        .sort();
      const lus = montagesDeVolume(nomService)
        .map((m) => `${m.source}:${m.cible}:${m.mode}`)
        .sort();
      assert.deepEqual(lus, attendus, nomService);
    }
  });

  it("D-2b-26 : `oc-data` (instance principale) n'est jamais monté dans la salle, sous aucun mode", () => {
    for (const montage of montages(SALLE)) {
      assert.notEqual(montage.source, "oc-data", `oc-data monté sur ${montage.cible}`);
      assert.notEqual(montage.source, "oc-config");
      assert.notEqual(montage.source, "control", "le volume de contrôle de l'instance principale reste hors de la salle");
    }
    // L'authentification passe par le seul volume réduit à l'entrée github-copilot, en lecture seule.
    const authSrc = montages(SALLE).find((m) => m.cible === "/auth-src");
    assert.deepEqual(authSrc, { source: "omo-auth", cible: "/auth-src", mode: "ro" });
  });

  it("D-2b-33 révisée : les cinq dossiers du HOME viennent d'`omo-config`, en `:ro`, et lui seul est écrit hors du HOME", () => {
    const parCible = new Map(montages(SALLE).map((m) => [m.cible, m]));
    for (const dossier of CONTRAT.dossiersConfigHome) {
      const montage = parCible.get(dossier);
      assert.ok(montage !== undefined, `${dossier} non monté`);
      assert.equal(montage.source, "omo-config", dossier);
      assert.equal(montage.mode, "ro", dossier);
    }
    assert.equal(CONTRAT.dossiersConfigHome.length, 5);
    // Le seul montage en écriture d'`omo-config` est hors du HOME : `node` ne peut pas atteindre ce que root y pose.
    const enEcriture = montages(SALLE).filter((m) => m.source === "omo-config" && m.mode !== "ro");
    assert.equal(enEcriture.length, 1);
    assert.equal(enEcriture[0]?.cible.startsWith("/home/node/"), false);
    // Plus aucun volume vide : `omo-vide` a disparu avec la révision du train de V1.
    assert.doesNotMatch(TEXTE_COMPOSE, /omo-vide/);
  });

  it("le dossier de travail est celui de l'instance principale, mais en LECTURE SEULE (L16c) ; les autorités d'entreprise aussi", () => {
    const parCible = new Map(montages(SALLE).map((m) => [m.cible, m]));
    assert.equal(parCible.get("/workspace")?.source, "${WORKSPACE_DIR}");
    assert.equal(parCible.get("/workspace")?.mode, "ro");
    // L'instance principale et le cockpit gardent l'écriture : seule la salle voit le dossier de travail en lecture seule.
    assert.equal(montages(PRINCIPALE).find((m) => m.cible === "/workspace")?.mode, "rw");
    assert.equal(parCible.get("/certs")?.source, "./certs");
    assert.equal(parCible.get("/certs")?.mode, "ro");
  });
});

// --- L16c : montages inversés et carnets de la salle (décision A16, option E1) -----------------------------------------------

describe("L16c : dossier de travail en lecture seule, écriture par exception, carnets dans un volume nommé", () => {
  /** Cible sous le dossier de travail de la salle, ou le dossier de travail lui-même. */
  const sousWorkspace = (cible: string) => cible === "/workspace" || cible.startsWith("/workspace/");

  it("le compose ne rouvre RIEN en écriture sous /workspace : toute exception vient de la surcharge d'install.ps1", () => {
    const sous = montages(SALLE).filter((m) => sousWorkspace(m.cible));
    assert.deepEqual(sous, [{ source: "${WORKSPACE_DIR}", cible: "/workspace", mode: "ro" }], JSON.stringify(sous));
    // Aucune ligne de la salle ne monte le dossier de travail en écriture, sous aucune forme (long ou court, avec ou sans mode).
    const bloc = TEXTE_COMPOSE.slice(TEXTE_COMPOSE.search(/^ {2}opencode-omo:$/m), TEXTE_COMPOSE.search(/^volumes:$/m));
    assert.doesNotMatch(bloc, /\$\{WORKSPACE_DIR\}:\/workspace(?::rw)?\s*$/m, "le dossier de travail de la salle doit rester en :ro");
  });

  it("carnets : le volume nommé `omo-carnets` est déclaré, monté dans la salle seule, HORS de tout projet, et donné à node", () => {
    assert.ok(Object.hasOwn(COMPOSE.volumes, "omo-carnets"), "volume omo-carnets non déclaré");
    const carnets = CONTRAT.volumes.find((v) => v.nom === "omo-carnets");
    assert.deepEqual(carnets, { nom: "omo-carnets", proprietaire: "node", ecrivain: "salle", montages: [{ service: "salle", cible: "/omo-carnets", mode: "rw" }] });
    const monte = montages(SALLE).find((m) => m.source === "omo-carnets");
    assert.deepEqual(monte, { source: "omo-carnets", cible: "/omo-carnets", mode: "rw" });
    assert.equal(sousWorkspace(monte?.cible ?? "/workspace"), false, "les carnets ne vivent jamais sous /workspace");
    // Aucun autre service ne le monte : ni le cockpit, ni egress, ni l'instance principale.
    for (const [nom, s] of Object.entries(COMPOSE.services)) {
      if (nom === SALLE || nom === SERVICE_INIT) continue;
      assert.equal((s.volumes ?? []).map(decouperMontage).some((m) => m.source === "omo-carnets"), false, `${nom} monte omo-carnets`);
    }
    // omo-init le donne à node (MO-11) : sans cela, node reçoit EACCES dans un volume neuf à root (mesure L16c, cas B).
    assert.match((service(SERVICE_INIT).command ?? []).join(" "), /chown node:node(?: \/[a-z0-9/-]+)* \/omo-carnets(?: |;|$)/);
  });

  it("aucun dossier .omo n'est créé sur le poste : aucun montage vers un .omo, ni dans le compose ni dans la surcharge générée", () => {
    // Monter un volume sous `/workspace/<projet>/.omo` CRÉE `.omo` chez l'utilisateur quand la racine est en écriture, et empêche
    // la salle de démarrer quand elle est en lecture seule (mesure L16c : « mkdirat …/.omo: read-only file system »).
    for (const [nom, s] of Object.entries(COMPOSE.services)) {
      for (const m of (s.volumes ?? []).map(decouperMontage)) {
        // `~/.omo` (dossier de configuration du HOME, D-2b-33) est dans l'image, jamais chez l'utilisateur : seul /workspace compte.
        assert.doesNotMatch(m.cible, /^\/workspace\/(?:.*\/)?\.omo(?:\/|$)/i, `${nom} : montage vers ${m.cible}`);
      }
    }
    // install.ps1 ne crée aucun dossier .omo et n'ouvre jamais un .omo existant : le nom est écarté des ouvertures en écriture.
    assert.doesNotMatch(TEXTE_INSTALL, /(?:New-Item|CreateDirectory|mkdir)[^\n]*\.omo/i);
    assert.match(TEXTE_INSTALL, /function Test-OmoNomCarnets\(/);
    assert.match(TEXTE_INSTALL, /if \(Test-OmoNomCarnets \$nom\) \{/);
  });

  it("la surcharge générée n'ouvre qu'en écriture, entrée par entrée, jamais .git ni la racine d'un projet (lecture d'install.ps1)", () => {
    // Le générateur est joué pour de vrai par tests/ps51/Test-OmoInstall.ps1 (arbre jetable, faux docker) ; ici, la forme.
    assert.match(TEXTE_INSTALL, /\$monte = \(\$source \+ ':' \+ \$item\.Cible \+ ':rw'\)/);
    assert.match(TEXTE_INSTALL, /Cible = \(\$OmoCibleWorkspace \+ '\/' \+ \$relatif\)/);
    assert.match(TEXTE_INSTALL, /\$relatif = \$chemin \+ '\/' \+ \$nom/);
    assert.match(TEXTE_INSTALL, /if \(Test-OmoNomGitOuCourt \$nom\) \{ continue \}/);
    // Plus aucun `.git:ro` généré : la protection vient de l'ancêtre en lecture seule, plus d'un bind sur le nom exact.
    assert.doesNotMatch(TEXTE_INSTALL, /\$cible \+ ':ro'/);
    // Friction dite à l'utilisateur (A16 point 6) : pas de création à la racine d'un projet, relance après un ajout.
    assert.match(TEXTE_INSTALL, /ne peut creer ni fichier ni dossier a la racine d un projet/);
    assert.match(TEXTE_INSTALL, /relancez install\.ps1/);
  });
});

// --- §4 Environnement -------------------------------------------------------------------------------------------------------

describe("L16b §4 : environnement de la salle = liste blanche du contrat (MO-10, demande (C) de L15a)", () => {
  const salle = service(SALLE);

  it("aucune variable hors de `variables.salle`, et toutes y sont", () => {
    const lues = Object.keys(salle.environment ?? {}).sort();
    assert.deepEqual(lues, [...CONTRAT.variables.salle].sort());
  });

  it("aucun `env_file` et aucune ancre `network-env` : le .env du cockpit n'entre pas dans la salle", () => {
    assert.equal(salle.env_file, undefined);
    assert.equal(service(EGRESS).env_file, undefined);
    assert.equal(service(SERVICE_INIT).env_file, undefined);
    // L'ancre porte des réglages du cockpit (COCKPIT_PROJECT_CONFIG, COCKPIT_TLS_INSECURE…) : elle ne doit pas fuir ici.
    const bloc = blocDeService(SALLE);
    assert.doesNotMatch(bloc, /network-env/);
    assert.doesNotMatch(bloc, /<</);
    assert.doesNotMatch(blocDeService(EGRESS), /network-env|<</);
  });

  it("toute la sortie passe par egress, et le trafic interne ne repasse pas par le proxy", () => {
    const env = salle.environment ?? {};
    const adresseEgress = `http://${EGRESS}:${CONTRAT.egress.port}`;
    assert.equal(env.HTTPS_PROXY, adresseEgress);
    assert.equal(env.HTTP_PROXY, adresseEgress);
    const hotes = String(env.NO_PROXY).split(",");
    assert.ok(hotes.includes("localhost"));
    assert.ok(hotes.includes(EGRESS));
    // L'instance principale n'est ni nommée, ni joignable : la salle est cloisonnée (P11).
    assert.ok(!hotes.includes(PRINCIPALE));
  });

  it("COCKPIT_COPILOT_API_URL n'est jamais vide dans la salle (validate.mjs refuse sinon)", () => {
    const valeur = String(salle.environment?.COCKPIT_COPILOT_API_URL);
    const defaut = /^\$\{COCKPIT_COPILOT_API_URL:-(https:\/\/[a-z0-9.-]+)\}$/.exec(valeur);
    assert.ok(defaut !== null, `défaut non vide attendu, lu : ${valeur}`);
    assert.equal(defaut[1], "https://api.githubcopilot.com");
  });

  it("le mot de passe de la salle est le sien, jamais celui de l'instance principale", () => {
    const env = salle.environment ?? {};
    assert.equal(env.OPENCODE_SERVER_USERNAME, "opencode");
    assert.match(String(env.OPENCODE_SERVER_PASSWORD), /^\$\{OPENCODE_OMO_PASSWORD:-\}$/);
    assert.doesNotMatch(String(env.OPENCODE_SERVER_PASSWORD), /OPENCODE_SERVER_PASSWORD/);
  });
});

/**
 * Texte du bloc YAML d'un service, de sa ligne d'en-tête au service suivant, commentaires retirés : une ancre de fusion
 * (`<<: *network-env`) disparaît à l'analyse, elle ne se lit que dans le texte.
 */
function blocDeService(nom: string): string {
  const debut = TEXTE_COMPOSE.indexOf(`\n  ${nom}:\n`);
  assert.notEqual(debut, -1, `bloc du service ${nom} introuvable`);
  const suite = TEXTE_COMPOSE.slice(debut + 1);
  const fin = suite.search(/\n(?:\S|  [a-z][a-z0-9-]*:\n)/);
  const bloc = fin === -1 ? suite : suite.slice(0, fin);
  return bloc
    .split("\n")
    .filter((ligne) => !ligne.trim().startsWith("#"))
    .join("\n");
}

// --- §5 Réseaux -------------------------------------------------------------------------------------------------------------

describe("L16b §5 : réseau fermé de la salle (MO-10)", () => {
  it("`omo-internal` est déclaré `internal: true` : aucune route par défaut, aucune résolution publique", () => {
    const reseau = COMPOSE.networks[CONTRAT.reseau];
    assert.ok(reseau !== undefined && reseau !== null, `réseau ${CONTRAT.reseau} absent`);
    assert.equal(reseau.internal, true);
    // MO-10 : le repli du plan (IPAM, dns, extra_hosts) n'est pas nécessaire ; l'écrire ici serait du bruit à maintenir.
    const texteReseaux = TEXTE_COMPOSE.slice(TEXTE_COMPOSE.lastIndexOf("\nnetworks:"));
    assert.doesNotMatch(texteReseaux, /ipam|extra_hosts/);
  });

  it("membres de `omo-internal` comptés un par un : cockpit, egress et la salle, jamais l'instance principale", () => {
    const membres = Object.keys(COMPOSE.services)
      .filter((nom) => reseaux(nom).includes(CONTRAT.reseau))
      .sort();
    assert.deepEqual(membres, [COCKPIT, EGRESS, SALLE].sort());
    assert.deepEqual(reseaux(PRINCIPALE), ["default"]);
    // La salle n'a QUE le réseau fermé : elle ne peut joindre ni l'instance principale, ni l'extérieur.
    assert.deepEqual(reseaux(SALLE), [CONTRAT.reseau]);
  });

  it("egress est le seul pont : il a les deux réseaux (MO-10 point 5)", () => {
    assert.deepEqual([...reseaux(EGRESS)].sort(), ["default", CONTRAT.reseau].sort());
    assert.deepEqual([...reseaux(COCKPIT)].sort(), ["default", CONTRAT.reseau].sort());
  });
});

// --- §6 egress --------------------------------------------------------------------------------------------------------------

describe("L16b §6 : service egress (C1-5, spéc. §3.15.2 l.518-522)", () => {
  const egress = service(EGRESS);

  it("commande : le proxy de sortie du cockpit, lancé sans shell", () => {
    assert.deepEqual(egress.command, ["node", "--disable-warning=ExperimentalWarning", "server/egress-proxy.ts"]);
    assert.equal(egress.entrypoint, undefined);
    assert.equal(fs.existsSync(path.join(RACINE, "app", "server", "egress-proxy.ts")), true);
  });

  it("healthcheck propre : sans lui, egress porterait celui du cockpit et ne serait JAMAIS sain", () => {
    const test = egress.healthcheck?.test ?? [];
    assert.equal(test[0], "CMD", "forme exec, jamais CMD-SHELL");
    assert.deepEqual(test.slice(1), ["node", "--disable-warning=ExperimentalWarning", "server/egress-proxy.ts", "--sonde"]);
    assert.match(String(egress.healthcheck?.interval), /^\d+s$/);
    assert.match(String(egress.healthcheck?.timeout), /^\d+s$/);
    // Le mode --sonde est bien celui d'egress-proxy.ts, et il est documenté comme le healthcheck de ce service.
    const source = fs.readFileSync(path.join(RACINE, "app", "server", "egress-proxy.ts"), "utf8");
    assert.match(source, /--sonde/);
  });

  it("durcissement : racine en lecture seule, aucune capacité, no-new-privileges, journal en écriture", () => {
    assert.equal(egress.read_only, true);
    assert.deepEqual(egress.cap_drop, ["ALL"]);
    assert.equal(egress.cap_add, undefined);
    assert.deepEqual(egress.security_opt, ["no-new-privileges:true"]);
    assert.equal(egress.restart, "unless-stopped");
    assert.equal(egress.init, true);
    const journal = montagesDeVolume(EGRESS);
    assert.deepEqual(journal, [{ source: "egress-log", cible: "/egress-log", mode: "rw" }]);
    assert.equal(egress.environment?.COCKPIT_EGRESS_JOURNAL, "/egress-log");
  });

  it("egress voit le proxy d'entreprise et l'adresse Copilot, jamais le reste du .env", () => {
    const attendues = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "COCKPIT_COPILOT_API_URL", "COCKPIT_GITHUB_ENTERPRISE_DOMAIN", "COCKPIT_EGRESS_JOURNAL", "TZ"];
    assert.deepEqual(Object.keys(egress.environment ?? {}).sort(), [...attendues].sort());
    assert.equal(egress.environment?.COCKPIT_TOKEN, undefined);
  });
});

// --- §7 cockpit -------------------------------------------------------------------------------------------------------------

describe("L16b §7 : le cockpit parle à la salle sans jamais en dépendre", () => {
  const cockpit = service(COCKPIT);

  it("variables `cockpit` du contrat toutes présentes, chemins conformes aux montages", () => {
    const env = cockpit.environment ?? {};
    for (const nom of CONTRAT.variables.cockpit) assert.ok(Object.hasOwn(env, nom), `${nom} absente du service ${COCKPIT}`);
    const parCible = new Map(montages(COCKPIT).map((m) => [m.cible, m]));
    assert.equal(parCible.get(String(env.COCKPIT_OMO_CONTROL_DIR))?.source, "control-omo");
    assert.equal(parCible.get(String(env.COCKPIT_OMO_AUTH_DIR))?.source, "omo-auth");
    assert.equal(parCible.get(String(env.COCKPIT_OMO_STATE_DIR))?.source, "omo-state");
    assert.equal(parCible.get(String(env.COCKPIT_EGRESS_JOURNAL))?.source, "egress-log");
    assert.equal(env.OPENCODE_OMO_URL, `http://${SALLE}:4096`);
    // La salle reste coupée d'office : aucune variable ne l'ouvre toute seule.
    assert.match(String(env.COCKPIT_OMO), /^\$\{COCKPIT_OMO:-off\}$/);
  });

  it("liste des projets préparés : la variable désigne la SOURCE sur l'hôte, jamais la destination du volume de contrôle", () => {
    const env = cockpit.environment ?? {};
    const source = String(env.COCKPIT_OMO_PROJECTS_FILE);
    const controle = String(env.COCKPIT_OMO_CONTROL_DIR);
    // `publishProjects()` (omo-control.ts) LIT cette variable et ÉCRIT dans `controlDir/<fichier du contrat>`. Les deux égaux,
    // il relirait ce qu'il vient d'écrire : « absent » sur une installation neuve, puis `retirer()` sur ce même chemin — la liste
    // n'atteindrait jamais la salle et une liste mal formée serait détruite sans pouvoir être régénérée.
    assert.notEqual(source, `${controle}/${CONTRAT.fichiersControle.projets}`);
    assert.ok(!source.startsWith(`${controle}/`), `${source} est dans le volume de contrôle (${controle})`);
    assert.ok(source.startsWith("/"), "chemin absolu du conteneur attendu");
    // Aucun bind statique dans docker-compose.yml : le fichier est git-ignoré et absent avant install.ps1 ; docker créerait un
    // DOSSIER vide à sa place, que `lireBorne` relirait « illisible » sur toute installation neuve.
    assert.equal(
      montages(COCKPIT).some((m) => m.cible === source),
      false,
      "la source est montée par la surcharge générée, pas par docker-compose.yml",
    );
    // La surcharge, elle, la monte en lecture seule sur le service `cockpit` : install.ps1 écrit ce montage mot pour mot.
    assert.match(TEXTE_INSTALL, new RegExp(`\\$OmoCibleProjetsSource = '${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
    assert.match(TEXTE_INSTALL, /\$lignes\.Add\('\s+' \+ \$OmoServiceCockpit \+ ':'\)/);
    assert.match(TEXTE_INSTALL, /\$monteListe = \(\$sourceListe \+ ':' \+ \$OmoCibleProjetsSource \+ ':ro'\)/);
    assert.match(TEXTE_INSTALL, new RegExp(`\\$OmoServiceCockpit = '${COCKPIT}'`));
    assert.ok(TEXTE_INSTALL.includes(SURCHARGE_PROJETS) || fs.readFileSync(path.join(RACINE, "CockpitTls.ps1"), "utf8").includes(SURCHARGE_PROJETS));
    // Le point de montage existe dans l'image : sans lui, un bind de fichier sur une racine en lecture seule n'a pas de place.
    const mkdir = argumentsDe(RUN_DOCKERFILE.find((i) => i.includes("mkdir")) ?? "", "mkdir").flat();
    assert.ok(mkdir.includes(path.posix.dirname(source)), `${path.posix.dirname(source)} : aucun mkdir dans app/Dockerfile`);
  });

  it("écrivains et lecteurs : le cockpit écrit ce que le contrat lui donne, et lit le reste", () => {
    for (const volume of CONTRAT.volumes) {
      const montage = volume.montages.find((m) => m.service === "cockpit");
      if (montage === undefined) continue;
      const attendu = volume.ecrivain === "cockpit" ? "rw" : "ro";
      assert.equal(montage.mode, attendu, `${volume.nom} : le contrat et l'écrivain ne concordent pas`);
      const lu = montages(COCKPIT).find((m) => m.source === volume.nom);
      assert.equal(lu?.mode, attendu, volume.nom);
    }
  });

  it("NO_PROXY du cockpit gagne la salle et egress, sans toucher l'ancre partagée", () => {
    const hotes = (valeur: string) => valeur.replace(/\$\{[^}]*\}*/g, "").split(",");
    const lus = hotes(String(cockpit.environment?.NO_PROXY));
    for (const nom of [PRINCIPALE, COCKPIT, SALLE, EGRESS]) assert.ok(lus.includes(nom), `${nom} absent de NO_PROXY`);
    // L'instance principale garde l'ancre d'origine : elle n'a rien à faire des noms de la salle.
    assert.ok(!hotes(String(service(PRINCIPALE).environment?.NO_PROXY ?? "")).includes(SALLE));
  });

  it("aucun `depends_on` vers un service à profil : salle coupée, le cockpit démarre quand même", () => {
    for (const [nom, s] of Object.entries(COMPOSE.services)) {
      for (const cible of Object.keys(s.depends_on ?? {})) {
        const cibleAProfil = (COMPOSE.services[cible]?.profiles ?? []).length > 0;
        if (!cibleAProfil) continue;
        // Seuls des services du MÊME profil peuvent dépendre d'un service à profil.
        assert.ok((s.profiles ?? []).length > 0, `${nom} dépend de ${cible}, qui n'existe pas sans profil`);
      }
    }
    assert.deepEqual(Object.keys(cockpit.depends_on ?? {}), [PRINCIPALE]);
  });
});

// --- §8 app/Dockerfile ------------------------------------------------------------------------------------------------------

describe("L16b §8 : app/Dockerfile crée les points de montage de la salle (MO-11, C1-5)", () => {
  const creesParLeDockerfile = argumentsDe(RUN_DOCKERFILE.find((i) => i.includes("mkdir")) ?? "", "mkdir").flat();
  const donnesANode = RUN_DOCKERFILE.flatMap((i) => argumentsDe(i, "chown"))
    .filter((mots) => mots[0] === "node:node")
    .flatMap((mots) => mots.slice(1));

  it("chaque volume nommé écrit par `node` dans cockpit ou egress est créé et donné à `node`", () => {
    let verifies = 0;
    for (const volume of CONTRAT.volumes) {
      if (volume.proprietaire !== "node") continue;
      for (const cle of ["cockpit", "egress"] as const) {
        const montage = volume.montages.find((m) => m.service === cle && m.mode === "rw");
        if (montage === undefined) continue;
        assert.ok(creesParLeDockerfile.includes(montage.cible), `${montage.cible} : aucun mkdir dans app/Dockerfile`);
        assert.ok(donnesANode.includes(montage.cible), `${montage.cible} : aucun chown node dans app/Dockerfile`);
        verifies += 1;
      }
    }
    assert.ok(verifies >= 3, `au moins control-omo, omo-auth et egress-log attendus, ${verifies} vérifiés`);
  });

  it("l'état publié par la salle reste à root : le cockpit ne fait que le lire", () => {
    const etat = CONTRAT.volumes.find((v) => v.proprietaire === "root" && v.montages.some((m) => m.service === "cockpit"));
    assert.ok(etat !== undefined, "un volume root lu par le cockpit est attendu (omo-state)");
    const cible = etat.montages.find((m) => m.service === "cockpit")?.cible ?? "";
    assert.ok(creesParLeDockerfile.includes(cible), `${cible} : aucun mkdir`);
    assert.ok(!donnesANode.includes(cible), `${cible} ne doit jamais être donné à node`);
  });

  it("l'image du cockpit garde ce qui ne regarde pas la salle : syntax, USER node, HEALTHCHECK", () => {
    assert.equal(TEXTE_DOCKERFILE.split("\n")[0], "# syntax=docker/dockerfile:1");
    assert.ok(INSTRUCTIONS_DOCKERFILE.includes("USER node"), "USER node gardé");
    assert.ok(
      INSTRUCTIONS_DOCKERFILE.some((i) => i.startsWith("HEALTHCHECK") && i.includes("server/healthcheck.ts")),
      "HEALTHCHECK du cockpit gardé",
    );
    // Aucun montage de la salle n'ouvre l'image : les dossiers sont vides et créés dans la même couche que les autres.
    assert.equal(RUN_DOCKERFILE.filter((i) => i.includes("mkdir")).length, 1);
  });
});

// --- §9 omo-init ------------------------------------------------------------------------------------------------------------

describe("L16b §9 : service d'initialisation jetable des volumes (MO-11)", () => {
  const init = service(SERVICE_INIT);

  it("chaque volume du contrat est monté par omo-init et donné à son propriétaire", () => {
    const parSource = new Map(montages(SERVICE_INIT).map((m) => [m.source, m]));
    const commande = (init.command ?? []).join(" ");
    for (const volume of CONTRAT.volumes) {
      const montage = parSource.get(volume.nom);
      assert.ok(montage !== undefined, `${volume.nom} non monté par ${SERVICE_INIT}`);
      assert.equal(montage.mode, "rw", volume.nom);
      const proprietaire = volume.proprietaire === "node" ? "node:node" : "root:root";
      const chown = new RegExp(`chown ${proprietaire}(?: /[a-z0-9/-]+)* ${montage.cible}(?: |;|$)`);
      assert.match(commande, chown, `${volume.nom} : chown ${proprietaire} ${montage.cible} attendu`);
    }
    assert.equal(parSource.size, CONTRAT.volumes.length, "aucun volume en trop");
  });

  it("jetable et borné : aucun réseau, aucune relance, root avec la seule capacité CHOWN", () => {
    assert.equal(init.network_mode, "none");
    assert.equal(init.networks, undefined);
    assert.equal(init.restart, "no");
    assert.equal(init.read_only, true);
    assert.equal(init.user, "0:0");
    assert.deepEqual(init.cap_drop, ["ALL"]);
    assert.deepEqual(init.cap_add, ["CHOWN"]);
    assert.deepEqual(init.security_opt, ["no-new-privileges:true"]);
    assert.equal(init.environment, undefined, "aucune variable : ce service ne lit rien du .env");
  });

  it("la salle attend que l'initialisation ait réussi", () => {
    assert.equal(service(SALLE).depends_on?.[SERVICE_INIT]?.condition, "service_completed_successfully");
  });
});

// --- §10 .dockerignore et .gitignore ----------------------------------------------------------------------------------------

describe("L16b §10 : l'extension et les sorties locales ne sortent pas du poste", () => {
  const lignes = (nom: string) =>
    fs
      .readFileSync(path.join(RACINE, nom), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));

  it(".dockerignore : docker/opencode-omo/ hors du contexte des images publiques (P13)", () => {
    assert.ok(lignes(".dockerignore").includes("docker/opencode-omo/"));
  });

  it(".gitignore : archive, SBOM, audit, projets préparés et surcharge des .git", () => {
    const attendues = [
      "opencode-cockpit-omo-*.tar.gz",
      "opencode-cockpit-omo-*.tar.gz.sha256",
      "opencode-cockpit-omo-*.sbom.json",
      "opencode-cockpit-omo-*.audit.json",
      CONTRAT.fichiersControle.projets,
      "docker-compose.omo-projets.yml",
    ];
    const lues = lignes(".gitignore");
    for (const attendue of attendues) assert.ok(lues.includes(attendue), attendue);
  });
});
