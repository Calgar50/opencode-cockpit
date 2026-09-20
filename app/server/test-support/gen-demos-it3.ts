// Propriétaire : L34.
// Générateur des deux démonstrations enregistrées ajoutées par l'itération 3 (spécification §5.9 l.1013-1017, §6 l.1064, JP-9 ;
// plan d'exécution it3, fiche L34, D-3d-26) : « Attente de votre accord » et « Arrêt au plafond ». La troisième démonstration du
// lecteur, « Deux assistants en même temps », est celle de L5d (web/pages/chat/activity/demo-p1.json, gen-demo.ts) : ce
// générateur ne la touche pas.
// - Source des événements : le FAUX opencode de test-support/fake-opencode.ts (T1), sur une adresse de bouclage ouverte le temps
//   de la génération. Tours SCRIPTÉS, aucun vrai opencode, aucune IA appelée, aucun appel facturé, aucun accès au réseau.
// - Faits : factsFromEvent par le chemin du magasin (EventMemory, FactDeduper), comme gen-demo.ts. Les faits ne portent aucun
//   texte de message (garde de activity-facts.ts, vérifiée fait par fait par assertFact avant l'écriture).
// - FAITS DE SERVICE (D-3d-26) : les faits que le cockpit lui-même écrirait (ici « decision » et « statut {cause: plafond} » de
//   l'arrêt au plafond) ne viennent d'aucun événement d'opencode. Ce générateur les écrit, et chacun porte `data.source =
//   "service"` pour le dire ; tous les autres faits viennent des événements du faux.
// - DÉTERMINISME : le faux tire ses identifiants au hasard et pose ses heures sur l'horloge du poste. Tous les blocs diffusés
//   sont donc CANONISÉS avant d'être dérivés : heure de réception du bloc n° i = DEBUT + i × PAS_MS, et chaque identifiant
//   opencode devient un identifiant de même forme (préfixe, 12 chiffres hexadécimaux = heure × 4096 + rang, puis un rang écrit
//   sur 14 chiffres), construit sur l'heure canonique du bloc où il apparaît pour la première fois. eventTime rend alors
//   exactement cette heure, et deux exécutions donnent le même fichier, à l'octet.
// - Les suites sont jouées une session à la fois, un outil par tour : l'ordre des blocs ne dépend d'aucune course.
//
// Régénérer, depuis app/ : node --disable-warning=ExperimentalWarning server/test-support/gen-demos-it3.ts
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFact, EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "../shared/activity-facts.ts";
import type { ActivityFact } from "../shared/activity-types.ts";
import { FakeOpencode, type FakeSession, type FakeToolScript, type FakeWireEvent } from "./fake-opencode.ts";
import { until } from "./helpers.ts";

/** Clés des deux suites produites ici ; les titres affichés sont ceux de revoir-texts.ts (T3d-b), jamais écrits dans ce module. */
export const DEMOS_IT3 = ["attente-accord", "arret-plafond"] as const;
export type DemoIt3Cle = (typeof DEMOS_IT3)[number];

/** Dossier lu par DemoPlayer.tsx. */
export const DEMOS_IT3_DIR = path.join(import.meta.dirname, "..", "..", "web", "pages", "chat", "activity", "demos");
export const fichierDemo = (cle: DemoIt3Cle): string => path.join(DEMOS_IT3_DIR, `${cle}.json`);

/** Heure du premier bloc de chaque suite (fixe) et écart entre deux blocs : aucun écart ne dépasse le seuil de raccourci (4 s). */
export const DEBUT_MS = 1_789_200_000_000;
export const PAS_MS = 250;

/** Contenu d'un fichier de démonstration : la suite, sa conversation et ses faits, dans l'ordre du magasin. */
export interface DemoIt3File {
  suite: DemoIt3Cle;
  rootId: string;
  faits: ActivityFact[];
}

/** Bloc canonisé : heure de réception fixe et charge utile d'un événement d'opencode. */
interface BlocCanonique {
  recv: number;
  payload: FactEvent;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- Canonisation des blocs diffusés ------------------------------------------------------------------------------------------

/** Identifiant opencode (préfixe court, puis au moins 16 caractères sans séparateur) : la seule forme que le faux tire au hasard. */
const ID_OPENCODE = /^[a-z]{1,16}_[0-9A-Za-z]{16,120}$/;

/**
 * Identifiant canonique de même forme que ceux d'opencode (id/id.ts) : 12 chiffres hexadécimaux valant (heure × 4096 + rang) sur
 * 48 bits, puis le numéro d'ordre écrit sur 14 chiffres (deux identifiants n'ont jamais le même). `rang` est le rang dans son
 * bloc et reste inférieur à 4096, donc idTime rend exactement `ms` : l'heure d'un fait dérivé de ce bloc est celle de sa
 * réception canonique.
 */
function idCanonique(prefixe: string, ms: number, rang: number, numero: number): string {
  const valeur = (BigInt(ms) * 4096n + BigInt(rang)) & 0xffff_ffff_ffffn;
  return `${prefixe}_${valeur.toString(16).padStart(12, "0")}${String(numero).padStart(14, "0")}`;
}

/** Remplace récursivement tout identifiant opencode d'une valeur ; `nouveau` n'est appelé que pour un identifiant jamais vu. */
function remplacerIds(valeur: unknown, connus: Map<string, string>, nouveau: (prefixe: string) => string): unknown {
  if (typeof valeur === "string") {
    if (!ID_OPENCODE.test(valeur)) return valeur;
    const deja = connus.get(valeur);
    if (deja !== undefined) return deja;
    const remplacant = nouveau(valeur.slice(0, valeur.indexOf("_")));
    connus.set(valeur, remplacant);
    return remplacant;
  }
  if (Array.isArray(valeur)) return valeur.map((element) => remplacerIds(element, connus, nouveau));
  if (isRecord(valeur)) {
    const sortie: Record<string, unknown> = {};
    for (const [cle, brut] of Object.entries(valeur)) sortie[cle] = remplacerIds(brut, connus, nouveau);
    return sortie;
  }
  return valeur;
}

/**
 * Blocs diffusés par le faux, rendus déterministes : heure de réception du bloc n° i = DEBUT_MS + i × PAS_MS, identifiants
 * renumérotés dans l'ordre de leur première apparition (l'identifiant du bloc lui-même prend le rang 1, pour que son heure soit
 * celle de sa réception). `ids` donne, pour chaque identifiant tiré par le faux, son identifiant canonique. Les blocs sans
 * propriétés (jumeaux « sync », que le faux ne diffuse pas ici) sont écartés.
 */
export function canoniser(blocs: readonly FakeWireEvent[], debut = DEBUT_MS, pas = PAS_MS): { blocs: BlocCanonique[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const sortie: BlocCanonique[] = [];
  let numero = 0;
  for (const bloc of blocs) {
    const payload = bloc.payload as unknown;
    if (!isRecord(payload) || !isRecord(payload.properties)) continue;
    const recv = debut + sortie.length * pas;
    let rang = 0;
    const suivant = (prefixe: string) => idCanonique(prefixe, recv, ++rang, ++numero);
    const id = typeof payload.id === "string" ? (remplacerIds(payload.id, ids, suivant) as string) : "";
    const type = typeof payload.type === "string" ? payload.type : "";
    const proprietes = remplacerIds(payload.properties, ids, suivant) as Record<string, unknown>;
    sortie.push({ recv, payload: { id, type, properties: proprietes } as FactEvent });
  }
  return { blocs: sortie, ids };
}

// --- Faits du magasin ----------------------------------------------------------------------------------------------------------

/** Messages de l'utilisateur envoyés par le cockpit (« votre demande ») : ceux de la conversation, jamais la consigne d'un enfant. */
export function messagesEnvoyes(blocs: readonly BlocCanonique[], rootId: string): Set<string> {
  const envoyes = new Set<string>();
  for (const { payload } of blocs) {
    if (payload.type !== "message.updated") continue;
    const info = (payload.properties as { info?: unknown } | undefined)?.info;
    if (!isRecord(info) || info.role !== "user" || info.sessionID !== rootId) continue;
    if (typeof info.id === "string") envoyes.add(info.id);
  }
  return envoyes;
}

/**
 * Faits d'une suite de blocs, comme le magasin les garde (même chemin que gen-demo.ts de L5d) : sessions de la conversation
 * `rootId` (enfants inscrits à leur création, un parent inconnu ne donne rien), rôles et parties des messages vus (EventMemory),
 * messages envoyés par le cockpit (`envoyes`), puis doublons écartés (FactDeduper). Aucune écriture, aucun réseau.
 */
export function faitsDesBlocs(blocs: readonly BlocCanonique[], rootId: string, envoyes: ReadonlySet<string>): ActivityFact[] {
  const sessions = new Map<string, FactSession>([[rootId, { rootId, parentId: null, purpose: "chat", instance: "principale" }]]);
  const resolve = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const connue = sessions.get(id);
    if (connue) return connue;
    if (info?.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (!parent) return null;
    return { rootId: parent.rootId, parentId, purpose: "chat", instance: "principale" };
  };
  const memory = new EventMemory();
  const deduper = new FactDeduper();
  const faits: ActivityFact[] = [];
  for (const { recv, payload } of blocs) {
    memory.observe(payload);
    const info = payload.properties?.info;
    if ((payload.type === "session.created" || payload.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = resolve(info.id, info);
      if (session) sessions.set(info.id, session);
    }
    const ctx: FactContext = {
      receivedAt: recv,
      session: resolve,
      messageRole: (id) => memory.messageRole(id),
      promptKind: (id) => (envoyes.has(id) ? "message" : null),
      firstUserMessage: (id) => memory.firstUserMessage(id),
      userMessageParts: (id) => memory.userMessageParts(id),
      unansweredUserMessages: (id) => memory.unansweredUserMessages(id),
    };
    for (const fait of factsFromEvent(payload, ctx)) if (deduper.accept(fait)) faits.push(fait);
  }
  return faits;
}

// --- Faits de service (D-3d-26) -------------------------------------------------------------------------------------------------

/**
 * Faits que le COCKPIT écrit lui-même quand le plafond de coût est atteint : ils ne viennent d'aucun événement d'opencode, et
 * chacun porte `data.source = "service"` pour le dire.
 * - « decision » : refus automatique du service d'autonomie, règle `plafond-cout` (une décision sans demande d'autorisation :
 *   `ref` est nul, donc aucun appel d'outil n'est marqué refusé) ;
 * - « statut {cause: "plafond"} » : l'arrêt lui-même (L1c), `debut` posé sur le dernier fait de la conversation, ce qui montre
 *   l'assistant de la conversation « arrêté » et laisse les délégations déjà rendues « terminées ».
 */
export function faitsDeService(rootId: string, faits: readonly ActivityFact[]): ActivityFact[] {
  const dernier = faits.at(-1)?.at ?? DEBUT_MS;
  return [
    {
      rootId,
      sessionId: rootId,
      kind: "decision",
      ref: null,
      data: { verdict: "refus-auto", regle: "plafond-cout", par: "cockpit", source: "service" },
      at: dernier + PAS_MS,
    },
    {
      rootId,
      sessionId: rootId,
      kind: "statut",
      ref: null,
      data: { cause: "plafond", motif: "plafond-cout", nonConfirmees: 0, debut: dernier, source: "service" },
      at: dernier + 2 * PAS_MS,
    },
  ];
}

// --- Banc : le faux opencode, sur une adresse de bouclage, le temps de la génération --------------------------------------------

interface Banc {
  faux: FakeOpencode;
  racine: FakeSession;
  /** POST authentifié vers le faux, sur l'adresse de bouclage qu'il vient d'ouvrir ; 204 (prompt_async) rend null. */
  poster<T>(chemin: string, corps: unknown): Promise<T | null>;
}

/**
 * Le faux n'est ouvert que le temps de la génération, et seulement sur l'adresse de bouclage ; il est fermé par un mot de passe TIRÉ À
 * CHAQUE EXÉCUTION (jamais écrit dans le dépôt, jamais dans les fixtures : il ne sort pas de ce processus).
 */
function ouvrir(base: string, motDePasse: string): Banc["poster"] {
  const authorization = `Basic ${Buffer.from(`opencode:${motDePasse}`).toString("base64")}`;
  return async <T>(chemin: string, corps: unknown): Promise<T | null> => {
    const reponse = await fetch(`${base}${chemin}`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(corps) });
    if (!reponse.ok) throw new Error(`faux opencode : ${reponse.status} sur ${chemin}`);
    if (reponse.status === 204) return null;
    return (await reponse.json()) as T;
  };
}

/** Envoi du cockpit : un message de l'utilisateur, en texte, comme POST …/prompt_async l'attend. */
const envoi = (contenu: string) => ({ agent: "build", parts: [{ type: "text", text: contenu }] });

/** Délégation scriptée : l'outil `task` d'opencode, autorisé d'office (aucune demande), avec son sous-agent et son coût. */
const delegation = (description: string, agent: string, cout: number): FakeToolScript => ({
  tool: "task",
  input: { description, subagent_type: agent, prompt: `[synthétique] ${description}` },
  child: { agent, text: `[synthétique] compte rendu de ${agent}`, cost: cout, tokens: { input: 900, output: 200 }, workMs: 2 },
});

/**
 * « Attente de votre accord » : l'assistant demande à lancer une commande, le cockpit attend votre accord, vous répondez « once »
 * (« cette fois seulement »), l'outil s'exécute et l'assistant reprend.
 */
async function jouerAttenteAccord({ faux, racine, poster }: Banc): Promise<void> {
  faux.script(racine.id, {
    stepMs: 2,
    cost: 0.0042,
    tokens: { input: 1_200, output: 180 },
    tools: [
      {
        tool: "bash",
        input: { command: "npm test", description: "Lancer la suite de tests" },
        ask: { permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" }, always: ["npm *"] },
        output: "[synthétique] 128 tests, 0 échec",
      },
    ],
    followUp: { text: "[synthétique] synthèse de l'assistant", cost: 0.0018, tokens: { input: 1_500, output: 90 } },
  });
  await poster(`/session/${racine.id}/prompt_async`, envoi("[synthétique] lance les tests du projet"));
  const demande = await until(() => faux.pendingPermissions()[0]);
  await poster(`/permission/${demande.id}/reply`, { reply: "once" });
  await faux.settled(racine.id);
}

/**
 * « Arrêt au plafond » : deux délégations successives, de coût croissant ; les faits de service écrits ensuite par
 * faitsDeService montrent le refus automatique puis l'arrêt au plafond.
 */
async function jouerArretPlafond({ faux, racine, poster }: Banc): Promise<void> {
  faux.script(
    racine.id,
    {
      stepMs: 2,
      cost: 0.0125,
      tokens: { input: 2_400, output: 260 },
      tools: [delegation("Relever les erreurs du journal", "explore", 0.031)],
      followUp: { text: "[synthétique] première synthèse", cost: 0.0031, tokens: { input: 2_900, output: 120 } },
    },
    {
      stepMs: 2,
      cost: 0.0207,
      tokens: { input: 3_600, output: 340 },
      tools: [delegation("Chercher la cause dans le code", "general", 0.078)],
      followUp: { text: "[synthétique] seconde synthèse", cost: 0.0064, tokens: { input: 4_100, output: 150 } },
    },
  );
  await poster(`/session/${racine.id}/prompt_async`, envoi("[synthétique] trouve pourquoi le service tombe en panne"));
  await faux.settled(racine.id);
  await poster(`/session/${racine.id}/prompt_async`, envoi("[synthétique] continue et propose un correctif"));
  await faux.settled(racine.id);
}

const SUITES: Readonly<Record<DemoIt3Cle, (banc: Banc) => Promise<void>>> = {
  "attente-accord": jouerAttenteAccord,
  "arret-plafond": jouerArretPlafond,
};

/** Une suite jouée sur le faux, puis dérivée : faits du magasin, faits de service, chacun passé par la garde des faits. */
export async function genererDemo(cle: DemoIt3Cle): Promise<DemoIt3File> {
  const motDePasse = randomBytes(24).toString("base64url");
  const faux = new FakeOpencode({ password: motDePasse, syncTwins: false, heartbeatMs: 3_600_000 });
  const poster = ouvrir(await faux.start(), motDePasse);
  try {
    const racine = await poster<FakeSession>("/session", { title: "[synthétique] démonstration enregistrée" });
    if (racine === null) throw new Error("le faux opencode n'a pas créé la conversation");
    await SUITES[cle]({ faux, racine, poster });
    const echec = faux.failures[0];
    if (echec !== undefined) throw echec instanceof Error ? echec : new Error("le faux opencode a échoué");
    const { blocs, ids } = canoniser(faux.emitted);
    const rootId = ids.get(racine.id);
    if (rootId === undefined) throw new Error("la conversation n'apparaît dans aucun bloc diffusé");
    const faits = faitsDesBlocs(blocs, rootId, messagesEnvoyes(blocs, rootId));
    const complets = cle === "arret-plafond" ? [...faits, ...faitsDeService(rootId, faits)] : faits;
    for (const fait of complets) assertFact(fait);
    return { suite: cle, rootId, faits: complets };
  } finally {
    await faux.close();
  }
}

/** Texte du fichier : un fait par ligne (différences lisibles), clés dans l'ordre du fait, fin de ligne finale. */
export function demoJson(file: DemoIt3File): string {
  const faits = file.faits.map((fait) => `    ${JSON.stringify(fait)}`).join(",\n");
  return ["{", `  "suite": ${JSON.stringify(file.suite)},`, `  "rootId": ${JSON.stringify(file.rootId)},`, '  "faits": [', faits, "  ]", "}", ""].join("\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(DEMOS_IT3_DIR, { recursive: true });
  for (const cle of DEMOS_IT3) {
    const fichier = fichierDemo(cle);
    const contenu = demoJson(await genererDemo(cle));
    fs.writeFileSync(fichier, contenu, "utf8");
    console.log(`${path.relative(process.cwd(), fichier)} : ${JSON.parse(contenu).faits.length} faits, ${Buffer.byteLength(contenu)} octets`);
  }
}
