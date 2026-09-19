// Propriétaire : L5d.
// Générateur de la démonstration p1 (spécification §5.9, JP-9 ; plan d'exécution, fiche L5d) : la capture réelle
// `fixtures/p1-delegation-parallele.jsonl` (opencode 1.18.30, deux délégations en même temps) devient les faits d'activité que le
// cockpit aurait enregistrés, par le chemin du magasin (activity-deriver.ts) : EventMemory, factsFromEvent, puis FactDeduper.
// Le fichier produit, `web/pages/chat/activity/demo-p1.json`, est rejoué par DemoPlayer.tsx dans la même scene(t) que le direct,
// sans aucune requête. demo-p1.test.ts vérifie qu'il vaut exactement la sortie de ce générateur, et y refait l'analyse de secrets
// des fixtures (fixtures/README.md, « Nettoyage »).
// Les faits ne portent aucun texte de message (garde de activity-facts.ts) : identifiants, codes, noms d'assistant et clés de
// chemin (pathKey), heures de la capture gardées telles quelles.
// Étapes du lecteur : parmi les moments (coupures nettes, moments() de neon-scene.ts), ceux où la scène du lecteur (zoom 2, mode
// Avancé : les délégations sont dessinées) change, indices de faits (provenance, P12) mis à part. Un moment sans changement
// n'est pas une étape : « Moment suivant » montre toujours quelque chose de nouveau.
//
// Régénérer, depuis app/ : node --disable-warning=ExperimentalWarning server/test-support/gen-demo.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "../shared/activity-facts.ts";
import type { ActivityFact } from "../shared/activity-types.ts";
import { moments, type NeonScene, type NeonSceneOptions, scene } from "../shared/neon-scene.ts";
import { readCapture } from "./fake-opencode.ts";

/** Capture rejouée et conversation de la démonstration p1. */
export const DEMO_P1_CAPTURE = "p1-delegation-parallele.jsonl";
export const DEMO_P1_ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
/** Seul message envoyé par le cockpit dans p1 (votre demande, origine « demande ») ; tout autre message suit son classement. */
export const DEMO_P1_SENT: readonly string[] = Object.freeze(["msg_09e702c4e001phPA6LcfC9t4WK"]);
/** Fichier lu par DemoPlayer.tsx. */
export const DEMO_P1_FILE = path.join(import.meta.dirname, "..", "..", "web", "pages", "chat", "activity", "demo-p1.json");

/** Scène du lecteur (DemoPlayer.tsx) : carte au zoom 2, délégations dessinées (la démonstration est enregistrée en mode Avancé). */
export const DEMO_SCENE: Readonly<NeonSceneOptions> = Object.freeze({ zoom: 2, mode: "avance" });

/** Contenu de demo-p1.json : la capture d'origine, ses faits dans l'ordre du magasin et les heures des étapes du lecteur. */
export interface DemoFile {
  source: string;
  rootId: string;
  faits: ActivityFact[];
  etapes: number[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Faits d'une capture, comme le magasin les garde : sessions de la conversation `rootId` (enfants inscrits à leur création, un
 * parent inconnu ne donne rien), rôles et parties des messages vus (EventMemory), messages envoyés par le cockpit (`sent`), puis
 * doublons écartés (FactDeduper). Aucune écriture, aucun réseau.
 */
export function demoFacts(capture: string, rootId: string, sent: readonly string[]): ActivityFact[] {
  const sessions = new Map<string, FactSession>([[rootId, { rootId, parentId: null, purpose: "chat", instance: "principale" }]]);
  const resolve = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const known = sessions.get(id);
    if (known) return known;
    if (info?.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (!parent) return null;
    return { rootId: parent.rootId, parentId, purpose: "chat", instance: "principale" };
  };
  const envoyes = new Set(sent);
  const memory = new EventMemory();
  const deduper = new FactDeduper();
  const faits: ActivityFact[] = [];
  for (const { recv, wire } of readCapture(capture)) {
    const event = wire.payload as FactEvent;
    memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
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
    for (const fait of factsFromEvent(event, ctx)) if (deduper.accept(fait)) faits.push(fait);
  }
  return faits;
}

/** Ce que montrent la carte et le tableau d'une scène : la scène sans ses indices de faits (provenance). */
export function dessin(vue: NeonScene): string {
  return JSON.stringify(vue, (cle: string, valeur: unknown) => (cle === "faits" ? undefined : valeur));
}

/** Heures des étapes : les moments où le dessin de la scène du lecteur change ; le premier moment en est toujours une. */
export function etapesVisibles(faits: readonly ActivityFact[], options: NeonSceneOptions = DEMO_SCENE): number[] {
  const etapes: number[] = [];
  let avant: string | null = null;
  for (const t of moments(faits)) {
    const vue = dessin(scene(faits, t, options));
    if (vue !== avant) etapes.push(t);
    avant = vue;
  }
  return etapes;
}

/** Démonstration p1 : faits de la capture p1, pour sa conversation, et étapes du lecteur. */
export function demoP1(): DemoFile {
  const faits = demoFacts(DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT);
  return { source: DEMO_P1_CAPTURE, rootId: DEMO_P1_ROOT, faits, etapes: etapesVisibles(faits) };
}

/** Texte du fichier : un fait par ligne (différences lisibles), clés dans l'ordre du fait, fin de ligne finale. */
export function demoJson(file: DemoFile): string {
  const faits = file.faits.map((fait) => `    ${JSON.stringify(fait)}`).join(",\n");
  return [
    "{",
    `  "source": ${JSON.stringify(file.source)},`,
    `  "rootId": ${JSON.stringify(file.rootId)},`,
    `  "etapes": ${JSON.stringify(file.etapes)},`,
    '  "faits": [',
    faits,
    "  ]",
    "}",
    "",
  ].join("\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const texte = demoJson(demoP1());
  fs.writeFileSync(DEMO_P1_FILE, texte, "utf8");
  console.log(`${path.relative(process.cwd(), DEMO_P1_FILE)} : ${demoP1().faits.length} faits, ${Buffer.byteLength(texte)} octets`);
}
