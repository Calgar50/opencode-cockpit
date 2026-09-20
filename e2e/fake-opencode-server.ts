// Banc e2e (L7a) : le faux opencode des tests, servi comme un vrai serveur dans la pile jetable.
//
// Il n'ajoute rien au faux (app/server/test-support/fake-opencode.ts, propriété de T1) : il l'enveloppe.
//   - le faux écoute sur la boucle locale du conteneur ; un relais l'expose sur 4096 pour le cockpit ;
//   - une interface de pilotage, sur 4097, laisse les scénarios relever les requêtes reçues et écrire les réponses.
//
// L'interface de pilotage exige un jeton (comparaison sans fuite de durée). Elle n'est publiée que sur 127.0.0.1 par
// docker-compose.e2e.yml, et le jeton est fabriqué à chaque exécution : rien n'est écrit dans le dépôt.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { FakeOpencode, type FakeTurnScript } from "../app/server/test-support/fake-opencode.ts";
// <c5:agents-import>
// Itération 5 (L50a) : agents servis par GET /agent, déclarés par un scénario (voir la section `c5:agents-du-banc`).
import { type FakeAgent, nativeAgents } from "../app/server/test-support/fake-opencode.ts";
// </c5:agents-import>

const PORT_API = Number(process.env.E2E_PORT_API ?? 4096);
const PORT_BANC = Number(process.env.E2E_PORT_BANC ?? 4097);
const MOT_DE_PASSE = process.env.E2E_FAUX_MOT_DE_PASSE ?? process.env.OPENCODE_SERVER_PASSWORD ?? "";
const JETON = process.env.E2E_JETON_CONTROLE ?? "";
const MAX_CORPS = 1_048_576;

if (!MOT_DE_PASSE) {
  console.error("faux opencode : E2E_FAUX_MOT_DE_PASSE manquant (le cockpit s'authentifie auprès d'opencode).");
  process.exit(2);
}
if (!JETON) {
  console.error("faux opencode : E2E_JETON_CONTROLE manquant (interface de pilotage du banc).");
  process.exit(2);
}

const memeSecret = (donne: string, attendu: string): boolean =>
  timingSafeEqual(createHash("sha256").update(donne).digest(), createHash("sha256").update(attendu).digest());

const faux = new FakeOpencode({
  password: MOT_DE_PASSE,
  directory: process.env.E2E_FAUX_DOSSIER ?? "/workspace",
  project: process.env.E2E_FAUX_PROJET ?? "global",
});
const amont = await faux.start();
const portAmont = Number(new URL(amont).port);

/**
 * Relais : le faux écoute sur 127.0.0.1 (il est écrit pour les tests, où c'est le bon choix), alors que le cockpit
 * l'appelle depuis un autre conteneur. Un relais d'octets ne change ni les en-têtes ni le flux d'événements.
 */
const relais = net.createServer((entrant) => {
  const sortant = net.connect(portAmont, "127.0.0.1");
  entrant.on("error", () => sortant.destroy());
  sortant.on("error", () => entrant.destroy());
  entrant.pipe(sortant);
  sortant.pipe(entrant);
});
relais.listen(PORT_API, "0.0.0.0", () => console.log(`faux opencode : API sur 0.0.0.0:${PORT_API}`));

// <c5:agents-du-banc>
// Itération 5 (L50a) : les assistants que le cockpit vient d'installer, servis ensuite par GET /agent.
//
// Pourquoi. Le cockpit ne propose la Seconde lecture que si le « Relecteur critique » est À LA FOIS installé (fichier
// d'agent écrit par le cockpit) ET vu par opencode (`second-reading.ts`) ; de même, le composeur ne propose que les
// assistants qu'opencode lui rend (`ChatPage.tsx`). Le faux, lui, ne lit aucun fichier : c'est donc le scénario qui lui
// dit, APRÈS l'installation, quels agents opencode sert. Avant elle, la liste reste celle des agents natifs — sans quoi
// le nom serait déjà pris et le cockpit en choisirait un autre (« relecteur-critique-2 »), qu'il ne retrouverait plus.
//
// Comment, sans route nouvelle : un scénario n'a que `scripter`, `tourParDefaut`, `requetes`, `evenements` et `oublier`
// (`e2e/lib/cockpit.mjs`, que la construction n'écrit pas). La conversation RÉSERVÉE ci-dessous n'est donc jamais
// scriptée : son « tour » porte la liste des agents, et chaque envoi remplace la liste entière.
const SESSION_AGENTS = "banc:agents";

/** Agent déclaré par un scénario : son nom, et l'IA que son fichier d'agent fixe, comme pour un assistant installé. */
interface AgentDuBanc {
  name: string;
  description?: string;
  mode?: FakeAgent["mode"];
  model?: { providerID: string; modelID: string };
}

/** Agent de GET /agent : seules sa présence, sa forme et son IA comptent ici ; aucune règle n'est inventée. */
const agentDuBanc = (agent: AgentDuBanc): FakeAgent => ({
  name: agent.name,
  description: agent.description ?? "Assistant installé par le cockpit (banc e2e).",
  mode: agent.mode ?? "primary",
  options: {},
  permission: [],
  ...(agent.model ? { model: agent.model } : {}),
});

const scripterOrigine = faux.script.bind(faux);
faux.script = (sessionID: string, ...tours: FakeTurnScript[]): void => {
  if (sessionID !== SESSION_AGENTS) {
    scripterOrigine(sessionID, ...tours);
    return;
  }
  const demandes = (tours as unknown as Array<{ agents?: AgentDuBanc[] }>).flatMap((tour) => tour.agents ?? []);
  faux.setAgents([...nativeAgents(faux.globalConfig.permission), ...demandes.map(agentDuBanc)]);
  console.log(`faux opencode : ${demandes.length} agent(s) déclaré(s) par le banc en plus des natifs.`);
};
// </c5:agents-du-banc>

// --- Interface de pilotage du banc ---------------------------------------------------------------

const lireCorps = async (req: http.IncomingMessage): Promise<unknown> => {
  const morceaux: Buffer[] = [];
  let taille = 0;
  for await (const morceau of req) {
    taille += (morceau as Buffer).length;
    if (taille > MAX_CORPS) throw new Error("corps trop long");
    morceaux.push(morceau as Buffer);
  }
  const texte = Buffer.concat(morceaux).toString("utf8");
  return texte ? JSON.parse(texte) : {};
};

const repondre = (res: http.ServerResponse, code: number, corps: unknown): void => {
  const texte = JSON.stringify(corps);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-security-policy": "default-src 'none'; sandbox" });
  res.end(texte);
};

const banc = http.createServer((req, res) => {
  void (async () => {
    try {
      const jeton = req.headers["x-banc-jeton"];
      if (typeof jeton !== "string" || !memeSecret(jeton, JETON)) {
        repondre(res, 401, { erreur: "jeton du banc manquant ou incorrect" });
        return;
      }
      const chemin = new URL(req.url ?? "/", "http://banc").pathname;
      if (req.method === "GET" && chemin === "/banc/etat") {
        repondre(res, 200, { version: faux.version, dossier: faux.directory, requetes: faux.requests.length, echecs: faux.failures.length });
        return;
      }
      if (req.method === "GET" && chemin === "/banc/requetes") {
        repondre(res, 200, { requetes: faux.requests });
        return;
      }
      if (req.method === "GET" && chemin === "/banc/evenements") {
        repondre(res, 200, { evenements: faux.emitted });
        return;
      }
      if (req.method === "POST" && chemin === "/banc/script") {
        const corps = (await lireCorps(req)) as { sessionID?: unknown; tours?: unknown };
        if (typeof corps.sessionID !== "string" || !Array.isArray(corps.tours)) {
          repondre(res, 400, { erreur: "sessionID (texte) et tours (liste) attendus" });
          return;
        }
        faux.script(corps.sessionID, ...(corps.tours as FakeTurnScript[]));
        repondre(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && chemin === "/banc/defaut") {
        const corps = (await lireCorps(req)) as { tour?: unknown };
        if (typeof corps.tour !== "object" || corps.tour === null) {
          repondre(res, 400, { erreur: "tour (objet) attendu" });
          return;
        }
        faux.defaultTurn = corps.tour as FakeTurnScript;
        repondre(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && chemin === "/banc/oublier") {
        faux.requests.length = 0;
        faux.emitted.length = 0;
        repondre(res, 200, { ok: true });
        return;
      }
      repondre(res, 404, { erreur: "route inconnue" });
    } catch (err) {
      repondre(res, 400, { erreur: err instanceof Error ? err.message : "requête refusée" });
    }
  })();
});
banc.listen(PORT_BANC, "0.0.0.0", () => console.log(`faux opencode : pilotage du banc sur 0.0.0.0:${PORT_BANC}`));

const arreter = (signal: string): void => {
  console.log(`faux opencode : arrêt (${signal}).`);
  relais.close();
  banc.close();
  void faux.close().then(() => process.exit(0));
};
process.on("SIGTERM", () => arreter("SIGTERM"));
process.on("SIGINT", () => arreter("SIGINT"));
