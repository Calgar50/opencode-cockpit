// Routes de l'onglet « Fichiers » (1.1, NAV-2 ; décisions A19 point 2, A21, A29 D14 ; fiche NAV §2.1, §2.3) : quatre routes POST
// de lecture seule, groupe « fichiers » du câblage 1.1, module « fichiers » (sans port). POST pour une lecture : l'anti-CSRF et
// le contrôle d'Origin de security.ts s'appliquent sans code nouveau, et le chemin n'apparaît ni dans l'adresse, ni dans
// l'historique, ni dans le journal (le onError global de http.ts journalise c.req.path). Aucune route GET, aucune écriture,
// aucun téléchargement, aucun identifiant de conversation (.strict() refuse tout champ en plus), aucun appel à opencode.
//
// Ordre imposé de chaque route : bodyLimit de 8 Kio avec son propre onError (413 « trop-long » ; sans lui, l'exception atteindrait
// le onError global : 500) ; interrupteur COCKPIT_FICHIERS=off (403 « fichiers-coupes ») ; JSON puis schéma zod .strict() (400
// « invalide », phrase française, jamais le message anglais de zod) ; règles pures puis protection (400 ou 403) AVANT tout accès
// au disque ; puis le lecteur (workspace-files.ts), créé une seule fois par installation. Corps d'erreur : {error, message}, la
// phrase « partout » de fichiers-texts.ts ; le web choisit sa phrase Simple ou Avancé d'après le code. Mêmes réponses dans les
// deux modes (P2).
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Cockpit11Module } from "./contracts-11.ts";
import type { Logger } from "./log.ts";
import { FICHIERS_ROUTES, NAV_BORNES } from "./shared/fichiers-regles.ts";
import { phraseErreur } from "./shared/fichiers-texts.ts";
import type { FichiersCode, FichiersErreur, FichiersRoute } from "./shared/fichiers-types.ts";
import { creerLecteurFichiers, type LecteurFichiers, type Resultat, reglesDemande } from "./workspace-files.ts";

/** Statut HTTP de chaque code (fiche §2.3). */
export const STATUTS_FICHIERS = {
  invalide: 400,
  "trop-long": 413,
  "fichiers-coupes": 403,
  protege: 403,
  lien: 403,
  "plusieurs-noms": 403,
  "projet-inconnu": 404,
  introuvable: 404,
  "pas-un-dossier": 409,
  "pas-un-fichier": 409,
  "a-change": 409,
  illisible: 409,
  occupe: 429,
} as const satisfies Record<FichiersCode, number>;

const PROJET = z.string().max(NAV_BORNES.SEGMENT_MAX_CARACTERES);
const CHEMIN = z.string().max(NAV_BORNES.CHEMIN_MAX_CARACTERES);

/** Corps des quatre routes : .strict(), tout champ en plus (sessionId, rootId…) est refusé. */
const SCHEMAS = {
  dossier: z.object({ projet: PROJET, chemin: CHEMIN }).strict(),
  contenu: z.object({ projet: PROJET, chemin: CHEMIN }).strict(),
  recents: z.object({ projet: PROJET }).strict(),
  recherche: z.object({ projet: PROJET, texte: z.string().min(1).max(NAV_BORNES.RECHERCHE_MAX_CARACTERES) }).strict(),
} as const;

const ROUTES: readonly FichiersRoute[] = ["dossier", "contenu", "recents", "recherche"];

function refus(c: Context, code: FichiersCode, route: FichiersRoute): Response {
  const corps: FichiersErreur = { error: code, message: phraseErreur(code, route) };
  return c.json(corps, STATUTS_FICHIERS[code]);
}

export interface FichiersRoutesDeps {
  /** false : COCKPIT_FICHIERS=off, les quatre routes répondent 403 « fichiers-coupes ». */
  actif: boolean;
  lecteur: LecteurFichiers;
  log: Pick<Logger, "warn">;
}

/**
 * Appel du lecteur pour une route ; le lecteur ne lève jamais, une exception ici serait un défaut du cockpit (409 illisible).
 * `signal` : annulation de la requête (connexion fermée par la page), transmise aux parcours : un parcours abandonné rend la place
 * unique (relecture F2-vague-6, constat n° 5).
 */
async function lire(deps: FichiersRoutesDeps, route: FichiersRoute, corps: Record<string, string>, signal: AbortSignal): Promise<Resultat<unknown>> {
  try {
    const projet = corps.projet ?? "";
    switch (route) {
      case "dossier":
        return await deps.lecteur.dossier({ projet, chemin: corps.chemin ?? "" });
      case "contenu":
        return await deps.lecteur.contenu({ projet, chemin: corps.chemin ?? "" });
      case "recents":
        return await deps.lecteur.recents({ projet, signal });
      case "recherche":
        return await deps.lecteur.recherche({ projet, texte: corps.texte ?? "", signal });
    }
  } catch (err) {
    // Nature seulement : un message d'erreur peut contenir un chemin.
    deps.log.warn("fichiers : erreur inattendue du lecteur", { route, nature: err instanceof Error ? err.name : typeof err });
    return { ok: false, code: "illisible" };
  }
}

/** Les quatre routes POST, aux adresses de FICHIERS_ROUTES, dans l'ordre imposé du §2.1. */
export function registerFichiersRoutes(app: Hono, deps: FichiersRoutesDeps): void {
  for (const route of ROUTES) {
    app.post(
      FICHIERS_ROUTES[route],
      bodyLimit({ maxSize: NAV_BORNES.CORPS_MAX_OCTETS, onError: (c) => refus(c, "trop-long", route) }),
      async (c) => {
        if (!deps.actif) return refus(c, "fichiers-coupes", route);
        let corps: unknown;
        try {
          corps = await c.req.json();
        } catch {
          // JSON illisible : refus en français, sans le message de l'analyseur.
          return refus(c, "invalide", route);
        }
        const lu = SCHEMAS[route].safeParse(corps);
        if (!lu.success) return refus(c, "invalide", route);
        const regles = reglesDemande(route, lu.data);
        if (!regles.ok) return refus(c, regles.code, route);
        const resultat = await lire(deps, route, lu.data as Record<string, string>, c.req.raw.signal);
        return resultat.ok ? c.json(resultat.valeur as object, 200) : refus(c, resultat.code, route);
      },
    );
  }
}

/**
 * Module « fichiers » du câblage 1.1 : ne lit que c11.env et c11.log (ni client, ni registre, ni base). Racine lue :
 * COCKPIT_FICHIERS_DIR (liste d'autorisation d'env.ts, D14 (a)), sinon le dossier de travail. Interrupteur : COCKPIT_FICHIERS,
 * actif quand il est absent.
 */
export const fichiersModule: Cockpit11Module = {
  name: "fichiers",
  install(reg, c11) {
    const env = c11.env;
    const log = c11.log;
    const lecteur = creerLecteurFichiers({ racine: env.fichiersDir ?? env.workspaceDir, log });
    const actif = env.fichiers !== false;
    reg.routes("fichiers", (app) => registerFichiersRoutes(app, { actif, lecteur, log }));
  },
};
