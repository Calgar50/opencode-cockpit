// Banc e2e (L7a) : le faux opencode des tests, servi comme un vrai serveur dans la pile jetable.
//
// Il n'ajoute rien au faux (app/server/test-support/fake-opencode.ts, propriété de T1) : il l'enveloppe.
//   - le faux écoute sur la boucle locale du conteneur ; un relais l'expose sur 4096 pour le cockpit ;
//   - une interface de pilotage, sur 4097, laisse les scénarios relever les requêtes reçues et écrire les réponses.
//
// L'interface de pilotage exige un jeton (comparaison sans fuite de durée). Elle n'est publiée que sur 127.0.0.1 par
// docker-compose.e2e.yml, et le jeton est fabriqué à chaque exécution : rien n'est écrit dans le dépôt.
//
// Équipes (it4, L41) : POST /banc/script accepte trois `sessionID` RÉSERVÉS — « quand:<champ>=<valeur> » (scriptWhen, pour les
// sessions d'étape que le runner crée lui-même), « config:global » (configuration globale du faux, lue à l'estimation par le
// pré-lancement) et « agents:defaut » (agents de GET /agent, que le faux ne lit pas dans les fichiers du Studio). Mêmes jeton et
// mêmes bornes que le reste du pilotage ; détails dans `pilotageEquipes`.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { FakeOpencode, type FakeSession, type FakeTurnScript } from "../app/server/test-support/fake-opencode.ts";

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

// --- équipes (it4) : début ---
/** Forme réservée d'un `sessionID` de pilotage qui vaut prédicat (voir `pilotageEquipes`). */
const PREFIXE_QUAND = "quand:";
/** Forme réservée d'un `sessionID` de pilotage qui fusionne la configuration globale du faux. */
const CONFIG_GLOBALE = "config:global";
/** Forme réservée d'un `sessionID` de pilotage qui remplace la liste d'agents servie par `GET /agent`. */
const AGENTS_PAR_DEFAUT = "agents:defaut";
/** Champs de la session lisibles par un sélecteur ; rien d'autre n'est exposé au pilotage. */
const CHAMPS_QUAND = ["etape", "cockpit", "run", "agent", "titre"] as const;

/**
 * Prédicat de `scriptWhen` écrit par un scénario, sous la forme « <champ>=<valeur> ». `etape`, `cockpit` et `run` lisent les
 * métadonnées posées par le runner des équipes (`metadata.cockpit`, `metadata.etape`, `metadata.run`) ; `agent` et `titre`
 * lisent la session elle-même. Toute autre forme rend null (400) : un sélecteur mal écrit ne doit pas scripter en silence
 * toutes les sessions.
 */
function predicatDe(selecteur: string): ((session: FakeSession) => boolean) | null {
  const coupe = selecteur.indexOf("=");
  if (coupe <= 0) return null;
  const champ = selecteur.slice(0, coupe);
  const valeur = selecteur.slice(coupe + 1);
  if (!(CHAMPS_QUAND as readonly string[]).includes(champ) || valeur === "") return null;
  return (session: FakeSession): boolean => {
    if (champ === "agent") return session.agent === valeur;
    if (champ === "titre") return session.title === valeur;
    const metadata = session.metadata as Record<string, unknown> | undefined;
    return metadata?.[champ] === valeur;
  };
}

/**
 * Pilotage des équipes, porté par la route `POST /banc/script` (même jeton, même borne de corps). Trois formes RÉSERVÉES de
 * `sessionID`, qu'aucun identifiant d'opencode ne peut prendre (ils commencent par « ses_ ») :
 *   - « quand:<champ>=<valeur> » : `scriptWhen`. Un scénario d'équipe ne connaît pas d'avance l'identifiant des sessions
 *     d'étape, que le runner crée lui-même : les tours valent alors pour TOUTE session créée ensuite qui correspond ;
 *   - « config:global » : la configuration globale rendue par `GET /global/config`, fusionnée avec `tours[0]`. Le
 *     pré-lancement la lit à l'estimation (D-eq-17) : c'est le seul moyen, depuis un scénario, de faire apparaître une
 *     extension (`mcp`, `plugin`) avant ou après l'estimation. Le cockpit n'écrit jamais cette configuration (P6) : le
 *     changement vient du banc, comme s'il venait de l'utilisateur ;
 *   - « agents:defaut » : la liste d'agents servie par `GET /agent`, remplacée par `tours`. Le faux ne lit pas les fichiers
 *     d'agents que le Studio écrit : un assistant installé par un exemple d'équipe doit donc lui être déclaré, comme le
 *     font les tests d'intégration (`h.fake.setAgents`).
 * Ces formes passent par `scripter(sessionID, ...tours)` parce que le client du banc (e2e/lib/cockpit.mjs) appartient à un
 * autre paquet et n'expose rien d'autre. Rend null quand le `sessionID` est une vraie session (script ordinaire).
 */
function pilotageEquipes(sessionID: string, tours: unknown[]): { code: number; corps: unknown } | null {
  if (sessionID.startsWith(PREFIXE_QUAND)) {
    const predicat = predicatDe(sessionID.slice(PREFIXE_QUAND.length));
    if (predicat === null) return { code: 400, corps: { erreur: `sélecteur « ${PREFIXE_QUAND}<champ>=<valeur> » attendu, champ parmi ${CHAMPS_QUAND.join(", ")}` } };
    faux.scriptWhen(predicat, ...(tours as FakeTurnScript[]));
    return { code: 200, corps: { ok: true, quand: sessionID } };
  }
  if (sessionID === CONFIG_GLOBALE) {
    const [fusion] = tours;
    if (typeof fusion !== "object" || fusion === null || Array.isArray(fusion)) {
      return { code: 400, corps: { erreur: `« ${CONFIG_GLOBALE} » attend un objet de configuration comme premier tour` } };
    }
    faux.globalConfig = { ...faux.globalConfig, ...(fusion as Record<string, unknown>) };
    return { code: 200, corps: { ok: true, cles: Object.keys(faux.globalConfig).sort((a, b) => a.localeCompare(b)) } };
  }
  if (sessionID === AGENTS_PAR_DEFAUT) {
    const nomme = (agent: unknown): agent is { name: string } => typeof agent === "object" && agent !== null && typeof (agent as { name?: unknown }).name === "string";
    if (tours.length === 0 || !tours.every(nomme)) return { code: 400, corps: { erreur: `« ${AGENTS_PAR_DEFAUT} » attend des agents (objets avec un « name ») comme tours` } };
    faux.setAgents(tours as Parameters<typeof faux.setAgents>[0]);
    return { code: 200, corps: { ok: true, agents: tours.map((agent) => agent.name) } };
  }
  return null;
}
// --- équipes (it4) : fin ---

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
        // --- équipes (it4) : début ---
        const pilotage = pilotageEquipes(corps.sessionID, corps.tours);
        if (pilotage !== null) {
          repondre(res, pilotage.code, pilotage.corps);
          return;
        }
        // --- équipes (it4) : fin ---
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
