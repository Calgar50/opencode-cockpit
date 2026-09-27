// Clients du banc (L21) : opencode de la salle (par l'espion) et pilotage du faux fournisseur.
//
// Le mot de passe de la salle est tiré au hasard à chaque exécution ; il vit dans ce module, dans le fichier d'environnement
// (0600) et nulle part ailleurs. Il n'est JAMAIS écrit dans un journal, un message d'erreur ou une sortie : chaque fonction
// d'ici ne rend que des codes, des tailles et des durées.
//
// Aucune dépendance npm (P8).
import http from "node:http";
import process from "node:process";

const MAX_CORPS = 8 * 1024 * 1024;

/** Requête HTTP simple. `corps` est un objet (envoyé en JSON) ou undefined. Rend `{ code, entetes, texte, json }`. */
export function requete({ hote = "127.0.0.1", port, methode = "GET", chemin, corps, entetes = {}, delaiMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const charge = corps === undefined ? null : Buffer.from(JSON.stringify(corps), "utf8");
    const req = http.request(
      {
        host: hote,
        port,
        method: methode,
        path: chemin,
        headers: {
          accept: "application/json",
          ...(charge ? { "content-type": "application/json", "content-length": String(charge.length) } : {}),
          ...entetes,
        },
      },
      (res) => {
        let texte = "";
        let octets = 0;
        res.setEncoding("utf8");
        res.on("data", (bloc) => {
          octets += bloc.length;
          if (octets <= MAX_CORPS) texte += bloc;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(texte);
          } catch {
            json = null;
          }
          resolve({ code: res.statusCode ?? 0, entetes: res.headers, texte, json, octets });
        });
      },
    );
    req.setTimeout(delaiMs, () => {
      req.destroy(new Error(`Requête trop longue (${delaiMs} ms) : ${methode} ${chemin}`));
    });
    req.on("error", reject);
    if (charge) req.write(charge);
    req.end();
  });
}

/** Client d'opencode-omo, vu par l'espion. `identifiants` porte le mot de passe : il ne sort jamais d'ici. */
export function clientOmo({ port, utilisateur, motDePasse }) {
  const autorisation = `Basic ${Buffer.from(`${utilisateur}:${motDePasse}`, "utf8").toString("base64")}`;
  const appel = (methode, chemin, corps, options = {}) =>
    requete({ port, methode, chemin, corps, entetes: { authorization: autorisation, ...(options.entetes ?? {}) }, delaiMs: options.delaiMs });
  return {
    port,
    get: (chemin, options) => appel("GET", chemin, undefined, options),
    post: (chemin, corps, options) => appel("POST", chemin, corps, options),
    /** Ouvre un flux et rend un objet contrôlable : `{ promesse, arreter() }`. */
    ouvrirFlux(chemin, surEvenement, options) {
      let req = null;
      const promesse = new Promise((resolve, reject) => {
        const r = http.request(
          { host: "127.0.0.1", port, method: "GET", path: chemin, headers: { authorization: autorisation, accept: "text/event-stream" } },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`flux ${chemin} : code ${res.statusCode}`));
              return;
            }
            let tampon = "";
            let n = 0;
            res.setEncoding("utf8");
            res.on("data", (bloc) => {
              tampon += bloc;
              let coupe = tampon.indexOf("\n\n");
              while (coupe !== -1) {
                const brut = tampon.slice(0, coupe);
                tampon = tampon.slice(coupe + 2);
                n += 1;
                const ligne = brut.split("\n").find((l) => l.startsWith("data:"));
                if (ligne) {
                  let donnee = null;
                  try {
                    donnee = JSON.parse(ligne.slice(5).trim());
                  } catch {
                    donnee = null;
                  }
                  try {
                    surEvenement({ n, recu: Date.now(), octets: brut.length, donnee });
                  } catch {
                    /* un rappel en erreur ne coupe pas le flux */
                  }
                }
                coupe = tampon.indexOf("\n\n");
              }
            });
            res.on("end", () => resolve({ evenements: n }));
            res.on("close", () => resolve({ evenements: n }));
          },
        );
        r.on("error", () => resolve({ evenements: 0 }));
        r.setTimeout(options?.delaiMs ?? 900_000, () => r.destroy());
        r.end();
        req = r;
      });
      return { promesse, arreter: () => req?.destroy() };
    },
  };
}

/**
 * Pilotage du faux fournisseur (L21a) : file de réponses, journal, remise à zéro.
 * Le pilotage écoute sur toutes les interfaces du conteneur : le faux exige donc un jeton, qui voyage dans un en-tête et
 * n'est jamais journalisé ni affiché.
 */
export function piloteFaux({ port, jeton = "" }) {
  const entetes = jeton === "" ? {} : { "x-pilote-jeton": jeton };
  return {
    port,
    reponses: (corps) => requete({ port, methode: "POST", chemin: "/reponses", corps, entetes }),
    modeles: (modeles) => requete({ port, methode: "POST", chemin: "/modeles", corps: { modeles }, entetes }),
    journal: () => requete({ port, chemin: "/journal", entetes }),
    reinitialiser: () => requete({ port, methode: "POST", chemin: "/reinitialiser", corps: {}, entetes }),
  };
}
