// Espion HTTP du banc (L21, compteurs L21b) : relais entre les clients du banc et `opencode-omo`, posé sur le réseau fermé.
//
// À quoi il sert. `opencode-omo` ne publie aucun port et ne vit que sur `omo-internal` : rien, depuis l'hôte, ne peut
// l'appeler. L'espion est le seul service du banc à toucher les deux réseaux ; il relaie, et il NOTE. Dans le banc complet
// (L21b), le cockpit réel lui-même parle à la salle À TRAVERS lui (`OPENCODE_OMO_URL` du cockpit pointe sur l'espion) : tout ce
// que le cockpit demande à la salle passe donc ici, et se compte.
//
// Ce qu'il note, ligne par ligne dans `espion.jsonl` : heure, méthode, chemin, classe, code, durée, octets, et pour un flux SSE
// le nombre d'événements et l'heure du premier et du dernier. Jamais un corps, jamais un en-tête d'autorisation : seulement sa
// présence. C'est la source des mesures de débit M20, M21 et R16.
//
// Ce qu'il COMPTE (L21b), et rend sur `GET /__espion/compteurs` (jamais relayé, rien de secret) :
// - les requêtes qui engagent la salle : `POST …/command` (G5 : il n'en faut AUCUNE), envois (`prompt_async`, `message`),
//   sessions créées par HTTP, abandons, suppressions ;
// - pour chaque flux d'événements relayé, le nombre d'événements PAR TYPE (`session.created`, `message.updated`…). Les sessions
//   et les messages que l'extension crée d'elle-même ne passent par aucune requête HTTP : ils ne se voient que là. Seul le TYPE
//   est lu dans le bloc, borné à une forme de nom d'événement ; le reste du bloc est relayé tel quel et oublié.
//
// Il ne transforme rien : même méthode, mêmes en-têtes (hors `host`), même corps, même flux, octet pour octet. Un relais qui
// tamponnerait un flux fausserait toutes les mesures de débit : `res.flushHeaders()` et un `pipe` direct l'évitent.
//
// Aucune dépendance npm (P8).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Chemin réservé aux compteurs : opencode n'a aucune route qui commence ainsi, il n'est donc jamais relayé. */
export const CHEMIN_COMPTEURS = "/__espion/compteurs";

/** Forme d'un type d'événement retenu ; tout le reste compte sous « (autre) ». */
const TYPE_EVENEMENT = /^[a-z][a-z0-9_.-]{0,59}$/;

/** Nombre de flux gardés dans les compteurs : les plus anciens fermés partent d'abord. */
const FLUX_GARDES = 32;

const ID = "[A-Za-z0-9_-]{1,128}";
/** Classes de requêtes comptées. L'ordre compte : la première qui correspond l'emporte. */
const CLASSES = Object.freeze([
  ["commande", "POST", new RegExp(`^/session/${ID}/command$`)],
  ["envoi", "POST", new RegExp(`^/session/${ID}/prompt_async$`)],
  ["message", "POST", new RegExp(`^/session/${ID}/message$`)],
  ["abandon", "POST", new RegExp(`^/session/${ID}/abort$`)],
  ["suppression", "DELETE", new RegExp(`^/session/${ID}$`)],
  ["session", "POST", /^\/session$/],
]);

/** Classe d'une requête relayée, ou null. `chemin` est sans chaîne de requête. */
export function classerRequete(methode, chemin) {
  const m = String(methode ?? "").toUpperCase();
  for (const [classe, attendue, motif] of CLASSES) {
    if (m === attendue && motif.test(chemin)) return classe;
  }
  return null;
}

/**
 * Type d'un bloc SSE (texte entre deux lignes vides) : la ligne `data:` lue en JSON, puis le type dans l'une des trois enveloppes
 * d'opencode (`{type}`, `{payload:{type}}`, `{directory, payload:{type}}`). Rend null pour un bloc sans donnée (commentaire,
 * battement) et « (autre) » pour une donnée illisible ou un type hors forme : un bloc n'est jamais compté sous un nom fabriqué.
 */
export function typeDuBloc(bloc) {
  const ligne = String(bloc)
    .split("\n")
    .find((l) => l.startsWith("data:"));
  if (ligne === undefined) return null;
  let donnee;
  try {
    donnee = JSON.parse(ligne.slice(5).trim());
  } catch {
    return "(autre)";
  }
  const type = donnee?.payload?.type ?? donnee?.type;
  return typeof type === "string" && TYPE_EVENEMENT.test(type) ? type : "(autre)";
}

/** Compteurs de l'espion : état en mémoire, rendu en JSON par `instantane()`. */
export function creerCompteurs(maintenant = () => Date.now()) {
  const depuis = maintenant();
  const requetes = { commande: 0, envoi: 0, message: 0, abandon: 0, suppression: 0, session: 0 };
  const flux = [];
  return {
    requete(classe) {
      if (classe !== null && Object.hasOwn(requetes, classe)) requetes[classe] += 1;
    },
    ouvrirFlux(n, chemin) {
      const entree = { n, chemin, ouvert: true, depuis: maintenant(), fin: null, evenements: 0, types: {} };
      flux.push(entree);
      // Les flux fermés partent d'abord : un flux ouvert n'est jamais oublié.
      while (flux.length > FLUX_GARDES) {
        const i = flux.findIndex((f) => !f.ouvert);
        flux.splice(i === -1 ? 0 : i, 1);
      }
      return {
        evenement(type) {
          entree.evenements += 1;
          if (type !== null) entree.types[type] = (entree.types[type] ?? 0) + 1;
        },
        fermer() {
          entree.ouvert = false;
          entree.fin = maintenant();
        },
      };
    },
    instantane() {
      return { at: maintenant(), depuis, requetes: { ...requetes }, flux: flux.map((f) => ({ ...f, types: { ...f.types } })) };
    },
  };
}

// --- Serveur ---------------------------------------------------------------------------------------------------------------------

function demarrer() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      amont: { type: "string" },
      "port-amont": { type: "string" },
      sortie: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const PORT = /^\d{1,5}$/.test(values.port ?? "") ? Number(values.port) : 4097;
  const AMONT = values.amont ?? "opencode-omo";
  const PORT_AMONT = /^\d{1,5}$/.test(values["port-amont"] ?? "") ? Number(values["port-amont"]) : 4096;
  const SORTIE = values.sortie ?? "/banc-out";

  fs.mkdirSync(SORTIE, { recursive: true });
  const JOURNAL = path.join(SORTIE, "espion.jsonl");
  const compteurs = creerCompteurs();

  let n = 0;

  const noter = (ligne) => {
    try {
      fs.appendFileSync(JOURNAL, `${JSON.stringify(ligne)}\n`);
    } catch {
      /* le journal n'est pas le service : une écriture ratée n'interrompt pas le relais */
    }
  };

  /** En-têtes relayés tels quels, sauf `host` (recalculé) ; l'autorisation passe mais n'est jamais notée. */
  const enTetesAmont = (entrants) => {
    const sortants = { ...entrants };
    delete sortants.host;
    return sortants;
  };

  const serveur = http.createServer((req, res) => {
    const chemin = (req.url ?? "/").split(/[?#]/, 1)[0].slice(0, 300);
    if (req.method === "GET" && chemin === CHEMIN_COMPTEURS) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(compteurs.instantane()));
      return;
    }
    n += 1;
    const numero = n;
    const debut = Date.now();
    const classe = classerRequete(req.method, chemin);
    compteurs.requete(classe);
    let octetsEntree = 0;
    let octetsSortie = 0;
    let evenements = 0;
    let premierEvenement = null;
    let dernierEvenement = null;
    let reste = "";

    req.on("data", (bloc) => {
      octetsEntree += bloc.length;
    });

    const amont = http.request(
      { host: AMONT, port: PORT_AMONT, method: req.method, path: req.url, headers: enTetesAmont(req.headers) },
      (reponse) => {
        const flux = String(reponse.headers["content-type"] ?? "").includes("text/event-stream");
        const suivi = flux ? compteurs.ouvrirFlux(numero, chemin) : null;
        const decodeur = new StringDecoder("utf8");
        res.writeHead(reponse.statusCode ?? 502, reponse.headers);
        if (flux) res.flushHeaders();
        reponse.on("data", (bloc) => {
          octetsSortie += bloc.length;
          if (suivi) {
            // Seul le type de chaque bloc est lu ; le texte lui-même n'est jamais gardé au-delà du bloc en cours.
            reste += decodeur.write(bloc);
            let coupe = reste.indexOf("\n\n");
            while (coupe !== -1) {
              evenements += 1;
              const at = Date.now();
              if (premierEvenement === null) premierEvenement = at;
              dernierEvenement = at;
              suivi.evenement(typeDuBloc(reste.slice(0, coupe)));
              reste = reste.slice(coupe + 2);
              coupe = reste.indexOf("\n\n");
            }
            if (reste.length > 1_000_000) reste = reste.slice(-2);
          }
        });
        reponse.pipe(res);
        const clore = () => {
          if (suivi) suivi.fermer();
        };
        reponse.on("close", clore);
        reponse.on("end", () => {
          clore();
          noter({
            n: numero,
            at: debut,
            methode: (req.method ?? "").slice(0, 10),
            chemin,
            classe,
            code: reponse.statusCode ?? 0,
            dureeMs: Date.now() - debut,
            octetsEntree,
            octetsSortie,
            flux,
            evenements,
            premierEvenement,
            dernierEvenement,
            autorisation: req.headers.authorization !== undefined,
          });
        });
      },
    );

    amont.on("error", (err) => {
      const motif = String(err?.code ?? err?.message ?? "erreur").slice(0, 60);
      noter({ n: numero, at: debut, methode: (req.method ?? "").slice(0, 10), chemin, classe, code: 0, dureeMs: Date.now() - debut, erreur: motif });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ espion: "amont injoignable", motif }));
    });

    req.on("aborted", () => amont.destroy());
    req.pipe(amont);
  });

  serveur.on("clientError", (_err, socket) => socket.destroy());
  serveur.listen(PORT, "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ pret: true, port: PORT, amont: `${AMONT}:${PORT_AMONT}` })}\n`);
  });

  const finir = () => {
    serveur.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", finir);
  process.on("SIGINT", finir);
}

// Lancé comme programme (le service `banc-espion`), il sert ; importé (tests, bibliothèques du banc), il ne fait rien.
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) demarrer();
