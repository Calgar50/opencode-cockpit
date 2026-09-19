// Journal des sorties refusées par `egress` (spéc. §3.15.2 l.521, G1) : `refus.jsonl`, une ligne {at, hote, port, raison} par refus,
// sans chemin, sans en-tête, sans identifiant. Borné à 1 Mio avec rotation (le fichier plein devient `refus.1.jsonl`). Écrit par
// egress seul (volume `egress-log`), lu en lecture seule par le cockpit : lireSortiesRefusees agrège les dernières 24 h par hôte pour
// le Diagnostic « Sorties refusées (24 h) » (branché par L26b et L18c, pas ici).
import fs from "node:fs/promises";
import path from "node:path";
import { EGRESS_NOM_MAX, EGRESS_REFUSAL_REASONS, type EgressRefusalReason } from "./shared/egress-allow.ts";

export const EGRESS_JOURNAL_FICHIER = "refus.jsonl";
export const EGRESS_JOURNAL_PRECEDENT = "refus.1.jsonl";
/** Taille au-delà de laquelle le journal tourne. */
export const EGRESS_JOURNAL_MAX = 1024 * 1024;
/** Dossier du journal dans egress et, en lecture seule, dans le cockpit (COCKPIT_EGRESS_JOURNAL, contrat de la salle). */
export const EGRESS_JOURNAL_DOSSIER_DEFAUT = "/egress-log";
/** Fenêtre du Diagnostic « Sorties refusées (24 h) ». */
export const EGRESS_FENETRE_DIAGNOSTIC_MS = 24 * 60 * 60_000;
/** Hôtes rendus au Diagnostic au plus (les plus refusés d'abord). */
export const EGRESS_HOTES_AGREGES_MAX = 50;
/** Lignes en attente d'écriture au plus : au-delà (salle qui inonde egress de demandes refusées), les suivantes sont comptées perdues. */
export const EGRESS_JOURNAL_ATTENTE_MAX = 1000;
/** Octets lus au plus par fichier, depuis la fin : un fichier grossi hors d'egress ne se lit jamais en entier. */
export const EGRESS_JOURNAL_LECTURE_MAX = 2 * EGRESS_JOURNAL_MAX;

/** Ligne du journal. at : ms depuis l'époque Unix ; port : 0 si absent ou illisible ; hote : "" si la demande n'en portait pas. */
export interface EgressRefus {
  at: number;
  hote: string;
  port: number;
  raison: EgressRefusalReason;
}

/** Agrégat par hôte des refus de la fenêtre ; `dernier` en ms depuis l'époque Unix (format de OmoStatusResponse, T3a). */
export interface SortieRefusee {
  hote: string;
  nombre: number;
  dernier: number;
}

/**
 * Hôte tel qu'il peut entrer au journal ou dans une trace : identifiants (« …@ ») et chemin (« /… », « ?… », « #… ») retirés,
 * minuscules, caractères hors ASCII visible remplacés par « ? », 253 caractères au plus. Ce que la salle écrit dans sa demande ne
 * peut donc ni y déposer un secret ni y faire tenir autre chose qu'un nom borné.
 */
export function hotePourJournal(hote: string): string {
  const sansIdentifiants = hote.slice(hote.lastIndexOf("@") + 1);
  const coupe = sansIdentifiants.search(/[/?#]/);
  const sansChemin = coupe === -1 ? sansIdentifiants : sansIdentifiants.slice(0, coupe);
  return sansChemin.slice(0, EGRESS_NOM_MAX).toLowerCase().replace(/[^\x21-\x7e]/g, "?");
}

const portPourJournal = (port: number): number => (Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0);

const RAISONS: ReadonlySet<string> = new Set(EGRESS_REFUSAL_REASONS);

/** Ligne relue conforme : champs attendus seulement, bornés. */
function estRefus(valeur: unknown): valeur is EgressRefus {
  if (typeof valeur !== "object" || valeur === null || Array.isArray(valeur)) return false;
  const v = valeur as Record<string, unknown>;
  return (
    Object.keys(v).length === 4 &&
    typeof v.at === "number" &&
    Number.isFinite(v.at) &&
    typeof v.hote === "string" &&
    v.hote.length <= EGRESS_NOM_MAX &&
    typeof v.port === "number" &&
    portPourJournal(v.port) === v.port &&
    typeof v.raison === "string" &&
    RAISONS.has(v.raison)
  );
}

/** Refus d'une ligne du journal ; null pour une ligne vide, illisible ou non conforme (ignorée). */
function lireLigne(ligne: string): EgressRefus | null {
  if (ligne.trim() === "") return null;
  try {
    const valeur: unknown = JSON.parse(ligne);
    return estRefus(valeur) ? valeur : null;
  } catch {
    return null;
  }
}

export interface JournalRefusOptions {
  dossier: string;
  /** Erreur d'écriture ou de rotation : jamais avalée, rendue à l'appelant (egress la trace). */
  onErreur: (err: unknown) => void;
  /** Lignes perdues parce que la file était pleine, signalées à la fin de l'écriture suivante. */
  onPerte?: (nombre: number) => void;
  tailleMax?: number;
  attenteMax?: number;
}

/** Écrivain unique du journal : lignes regroupées, écrites dans l'ordre, rotation avant qu'une écriture ne dépasse la borne. */
export class JournalRefus {
  readonly #fichier: string;
  readonly #precedent: string;
  readonly #tailleMax: number;
  readonly #attenteMax: number;
  readonly #onErreur: (err: unknown) => void;
  readonly #onPerte: (nombre: number) => void;
  readonly #enAttente: string[] = [];
  #perdues = 0;
  /** Taille connue du fichier courant ; null tant qu'elle n'a pas été lue. */
  #taille: number | null = null;
  #ecriture: Promise<void> | null = null;

  constructor(options: JournalRefusOptions) {
    this.#fichier = path.join(options.dossier, EGRESS_JOURNAL_FICHIER);
    this.#precedent = path.join(options.dossier, EGRESS_JOURNAL_PRECEDENT);
    this.#tailleMax = options.tailleMax ?? EGRESS_JOURNAL_MAX;
    this.#attenteMax = options.attenteMax ?? EGRESS_JOURNAL_ATTENTE_MAX;
    this.#onErreur = options.onErreur;
    this.#onPerte = options.onPerte ?? (() => undefined);
  }

  /** Dossier présent et inscriptible (au démarrage d'egress : un journal impossible à écrire empêche de démarrer). */
  static async verifierDossier(dossier: string): Promise<void> {
    await fs.mkdir(dossier, { recursive: true });
    await fs.access(dossier, fs.constants.W_OK);
  }

  /** Ajoute un refus ; seuls {at, hote, port, raison} sont écrits, hôte et port bornés. */
  ecrire(refus: EgressRefus): void {
    if (this.#enAttente.length >= this.#attenteMax) {
      this.#perdues++;
      return;
    }
    const ligne: EgressRefus = {
      at: Number.isFinite(refus.at) ? Math.trunc(refus.at) : 0,
      hote: hotePourJournal(refus.hote),
      port: portPourJournal(refus.port),
      raison: refus.raison,
    };
    this.#enAttente.push(`${JSON.stringify(ligne)}\n`);
    this.#ecriture ??= this.#vider();
  }

  /** Attend la fin des écritures en cours (arrêt d'egress, tests). */
  async attendre(): Promise<void> {
    while (this.#ecriture !== null) await this.#ecriture;
  }

  async #vider(): Promise<void> {
    // Une tâche d'écriture à la fois : les lignes arrivées pendant une écriture partent dans la suivante, dans l'ordre.
    await Promise.resolve();
    try {
      while (this.#enAttente.length > 0) {
        const lot = this.#enAttente.splice(0).join("");
        const perdues = this.#perdues;
        this.#perdues = 0;
        try {
          await this.#ajouter(lot);
        } catch (err) {
          this.#onErreur(err);
        }
        if (perdues > 0) this.#onPerte(perdues);
      }
    } finally {
      this.#ecriture = null;
    }
  }

  async #ajouter(lot: string): Promise<void> {
    const octets = Buffer.byteLength(lot);
    if (this.#taille === null) {
      this.#taille = await fs.stat(this.#fichier).then(
        (s) => s.size,
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return 0;
          throw err;
        },
      );
    }
    if (this.#taille > 0 && this.#taille + octets > this.#tailleMax) {
      await fs.rename(this.#fichier, this.#precedent);
      this.#taille = 0;
    }
    await fs.appendFile(this.#fichier, lot, { encoding: "utf8", mode: 0o644 });
    this.#taille += octets;
  }
}

/**
 * Fin d'un fichier (EGRESS_JOURNAL_LECTURE_MAX octets au plus) ; "" s'il n'existe pas. Autre chose qu'un fichier ordinaire (dossier,
 * lien) : erreur, jamais suivi.
 */
async function lireFin(fichier: string): Promise<string> {
  try {
    if (!(await fs.lstat(fichier)).isFile()) throw new Error(`journal des refus : ${path.basename(fichier)} n'est pas un fichier ordinaire.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
  const handle = await fs.open(fichier, "r");
  try {
    const { size } = await handle.stat();
    const longueur = Math.min(size, EGRESS_JOURNAL_LECTURE_MAX);
    const tampon = Buffer.alloc(longueur);
    let lus = 0;
    while (lus < longueur) {
      const { bytesRead } = await handle.read(tampon, lus, longueur - lus, size - longueur + lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
    }
    return tampon.subarray(0, lus).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Refus des `fenetreMs` dernières millisecondes avant `now`, agrégés par hôte (fichier précédent compris), les plus refusés d'abord,
 * EGRESS_HOTES_AGREGES_MAX hôtes au plus. Lignes illisibles ou non conformes ignorées ; journal absent : liste vide ; toute autre
 * erreur de lecture est rendue à l'appelant (jamais « aucun refus » par défaut).
 */
export async function lireSortiesRefusees(
  now: number,
  fenetreMs: number = EGRESS_FENETRE_DIAGNOSTIC_MS,
  dossier: string = EGRESS_JOURNAL_DOSSIER_DEFAUT,
): Promise<SortieRefusee[]> {
  const depuis = now - fenetreMs;
  const parHote = new Map<string, SortieRefusee>();
  for (const fichier of [EGRESS_JOURNAL_PRECEDENT, EGRESS_JOURNAL_FICHIER]) {
    const texte = await lireFin(path.join(dossier, fichier));
    for (const ligne of texte.split("\n")) {
      const refus = lireLigne(ligne);
      if (refus === null || refus.at < depuis) continue;
      const agregat = parHote.get(refus.hote);
      if (agregat) {
        agregat.nombre++;
        agregat.dernier = Math.max(agregat.dernier, refus.at);
      } else {
        parHote.set(refus.hote, { hote: refus.hote, nombre: 1, dernier: refus.at });
      }
    }
  }
  return [...parHote.values()]
    .sort((a, b) => b.nombre - a.nombre || b.dernier - a.dernier || a.hote.localeCompare(b.hote))
    .slice(0, EGRESS_HOTES_AGREGES_MAX);
}
