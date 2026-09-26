// Propriétaire : NAV-3.
// Client de l'onglet « Fichiers » (1.1, décisions A19 point 2, A21 ; fiche NAV §2.1, §5) : quatre routes POST, en lecture seule.
// Client mince par http.post, qui pose déjà l'en-tête anti-CSRF (api.ts n'est pas modifié) ; adresses tirées de FICHIERS_ROUTES,
// écrites une seule fois pour le serveur et le web ; signal d'annulation obligatoire à chaque appel. Aucun autre appel : ni
// opencode, ni conversation, ni changement de projet du chat (D14 (b)).
//
// Deux files d'attente, du côté du navigateur, suivent les bornes du serveur (fiche §2.3, §2.8) : deux lectures à la fois
// (LECTURES_SIMULTANEES, au-delà le serveur attend puis rend 429 « occupe ») et un seul parcours à la fois (récents ou recherche,
// sinon 429 « occupe » tout de suite). Elles évitent qu'« Actualiser » ou une recherche lancée pendant le chargement des récents
// ne se heurtent à leurs propres limites ; un second onglet peut toujours recevoir « occupe » (fiche §11, reste n° 7).
import { FICHIERS_ROUTES, NAV_BORNES } from "../../server/shared/fichiers-regles.ts";
import type { ContenuReponse, DossierReponse, FichiersCode, RechercheReponse, RecentsReponse } from "../../server/shared/fichiers-types.ts";
import { ApiError, http } from "./api.ts";

export type Tache = <T>(tache: () => Promise<T>, signal: AbortSignal) => Promise<T>;

/**
 * File d'attente à `limite` places : une tâche attend qu'une place se libère, la place lui est transmise directement (jamais plus
 * de `limite` tâches à la fois) ; annulée pendant l'attente, elle quitte la file sans avoir été lancée.
 */
export function fileDAttente(limite: number): Tache {
  let actives = 0;
  const enAttente: Array<() => void> = [];
  const liberer = () => {
    const reveil = enAttente.shift();
    if (reveil) reveil();
    else actives--;
  };
  return async <T>(tache: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    if (actives < limite) {
      actives++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const reveil = () => {
          signal.removeEventListener("abort", annuler);
          resolve();
        };
        const annuler = () => {
          const i = enAttente.indexOf(reveil);
          if (i !== -1) enAttente.splice(i, 1);
          reject(signal.reason);
        };
        enAttente.push(reveil);
        signal.addEventListener("abort", annuler, { once: true });
      });
    }
    // Réveillée puis annulée avant de tourner : la tâche part quand même, et fetch la refuse aussitôt (signal déjà annulé).
    try {
      return await tache();
    } finally {
      liberer();
    }
  };
}

const lectures = fileDAttente(NAV_BORNES.LECTURES_SIMULTANEES);
const parcours = fileDAttente(1);

export const fichiersApi = {
  /** Liste d'un dossier ; `chemin` relatif au projet, "" pour le projet lui-même ; projet "" = tout le dossier de travail. */
  dossier: (projet: string, chemin: string, signal: AbortSignal) =>
    lectures(() => http.post<DossierReponse>(FICHIERS_ROUTES.dossier, { projet, chemin }, { signal }), signal),
  /** Contenu d'un fichier, décodé, borné et masqué par le serveur (texte seul, jamais d'octets). */
  contenu: (projet: string, chemin: string, signal: AbortSignal) =>
    lectures(() => http.post<ContenuReponse>(FICHIERS_ROUTES.contenu, { projet, chemin }, { signal }), signal),
  /** Fichiers modifiés récemment (parcours borné). */
  recents: (projet: string, signal: AbortSignal) =>
    parcours(() => http.post<RecentsReponse>(FICHIERS_ROUTES.recents, { projet }, { signal }), signal),
  /** Recherche sur le NOM seulement, jamais sur le contenu (parcours borné). */
  recherche: (projet: string, texte: string, signal: AbortSignal) =>
    parcours(() => http.post<RechercheReponse>(FICHIERS_ROUTES.recherche, { projet, texte }, { signal }), signal),
};

const CODES: ReadonlySet<string> = new Set<FichiersCode>([
  "invalide",
  "trop-long",
  "fichiers-coupes",
  "protege",
  "lien",
  "plusieurs-noms",
  "projet-inconnu",
  "introuvable",
  "pas-un-dossier",
  "pas-un-fichier",
  "a-change",
  "illisible",
  "occupe",
]);

/** Code d'un refus des routes « fichiers », ou null (réseau, session du cockpit, erreur inattendue : phrase d'erreur générale). */
export function codeFichiers(err: unknown): FichiersCode | null {
  return err instanceof ApiError && CODES.has(err.code) ? (err.code as FichiersCode) : null;
}

/** Appel annulé (projet changé, « Actualiser », page quittée) : rien à afficher. */
export function estAnnule(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}
