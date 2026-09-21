// Espion HTTP du banc (L21) : relais entre le client du banc et `opencode-omo`, posé sur le réseau fermé.
//
// À quoi il sert. `opencode-omo` ne publie aucun port et ne vit que sur `omo-internal` : rien, depuis l'hôte, ne peut
// l'appeler. L'espion est le seul service du banc à toucher les deux réseaux ; il relaie, et il NOTE.
//
// Ce qu'il note, ligne par ligne dans `espion.jsonl` : heure, méthode, chemin, code, durée, octets, et pour un flux SSE le
// nombre d'événements et l'heure du premier et du dernier. Jamais un corps, jamais un en-tête d'autorisation : seulement sa
// présence. C'est la source des mesures de débit M20, M21 et R16.
//
// Il ne transforme rien : même méthode, mêmes en-têtes (hors `host`), même corps, même flux, octet pour octet. Un relais qui
// tamponnerait un flux fausserait toutes les mesures de débit : `res.flushHeaders()` et un `pipe` direct l'évitent.
//
// Aucune dépendance npm (P8).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

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
  n += 1;
  const numero = n;
  const debut = Date.now();
  const chemin = (req.url ?? "/").split(/[?#]/, 1)[0].slice(0, 300);
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
      res.writeHead(reponse.statusCode ?? 502, reponse.headers);
      if (flux) res.flushHeaders();
      reponse.on("data", (bloc) => {
        octetsSortie += bloc.length;
        if (flux) {
          // Comptage des événements SSE sans jamais garder le texte : seuls les séparateurs de blocs sont comptés.
          reste += bloc.toString("latin1");
          let coupe = reste.indexOf("\n\n");
          while (coupe !== -1) {
            evenements += 1;
            const at = Date.now();
            if (premierEvenement === null) premierEvenement = at;
            dernierEvenement = at;
            reste = reste.slice(coupe + 2);
            coupe = reste.indexOf("\n\n");
          }
          if (reste.length > 1_000_000) reste = reste.slice(-2);
        }
      });
      reponse.pipe(res);
      reponse.on("end", () => {
        noter({
          n: numero,
          at: debut,
          methode: (req.method ?? "").slice(0, 10),
          chemin,
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
    noter({ n: numero, at: debut, methode: (req.method ?? "").slice(0, 10), chemin, code: 0, dureeMs: Date.now() - debut, erreur: motif });
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
