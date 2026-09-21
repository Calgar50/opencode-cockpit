// Propriétaire : L18a.
// Exécution de l'instance de la Salle OMO (spécification §3.8 l.325, §3.9 l.331, §3.10 l.358-359, §3.13 l.412 ; plan 2 bis,
// fiche L18a) : second client opencode (adresse et mot de passe d'`env.omo`), second portillon (registre des réponses émises
// propre à la salle, base de la détection 1, D-2b-20), second EventProcessor, catalogue et recherche d'agents propres, compteur
// d'envois facturés propre — et les dépendances d'instance (InstanceDeps) qu'ils forment.
//
// Ce que cette instance NE fait PAS, et qui tient toute la sûreté du branchement (P11) :
// - le catalogue de la salle n'a AUCUN abonné `onChange` : un changement du catalogue de la salle ne recalcule pas les niveaux
//   d'IA de l'instance principale et ne déclenche jamais `copilotConfig.sync()` (qui écrirait la configuration de l'instance
//   principale, §3.13) ;
// - sa recherche d'agents (OcLookup) ne lit AUCUN fichier du cockpit : son dossier de configuration est un chemin réservé qui
//   n'existe pas, la configuration de l'instance principale ne peut donc pas déteindre sur une commande de la salle ;
// - son client est posé sur le suivi des sessions et sur l'archive (useClient) : une session de la salle n'est jamais demandée
//   à l'opencode de l'instance principale, et un 404 de l'un ne marque jamais une conversation de l'autre supprimée (D-2b-05) ;
// - le compteur d'envois facturés est le sien : un envoi de la salle en vol ne bloque ni le Studio, ni le redémarrage, ni le
//   rechargement de l'instance principale (la garde de rechargement ne lit que le compteur du proxy principal).
//
// `creerInstanceOmo` n'est appelée que derrière SALLE_OUVERTE : l'intégrateur la branche dans main.ts au train de V3. Tant que
// la salle est coupée, `instances.omo` vaut null — aucun client, aucun processeur, aucune inscription de la salle active.
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveService } from "./archive.ts";
import { ModelCatalog } from "./catalog.ts";
import type { Classifier } from "./classifier.ts";
import type { CopilotApi } from "./copilot.ts";
import { type AppEnv, omoOf } from "./env.ts";
import type { EventHub } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { OcLookup } from "./oc-lookup.ts";
import type { InstanceDeps } from "./omo-contracts.ts";
import { OpencodeClient } from "./opencode.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { EventProcessor } from "./processor.ts";
import type { ProjectsService } from "./projects.ts";
import type { SessionTracker } from "./sessions.ts";

/** Instance de la salle, quand elle existe ; null tant que la salle est coupée (le dépôt). */
export type OmoInstance = InstanceDeps | null;

/** Squelette : la salle n'a pas d'exécution. Gardé pour les montages qui n'ouvrent jamais la salle. */
export const OMO_INSTANCE_ABSENTE: OmoInstance = null;

/**
 * Dossier de configuration donné à la recherche d'agents de la salle : un chemin réservé, SOUS le dossier de données du
 * cockpit et sans existence, pour qu'aucun fichier de la configuration de l'instance principale (commands/<nom>.md) ne soit lu
 * pour une commande de la salle. La salle a sa propre configuration, dans son image, en lecture seule.
 */
export const OMO_SANS_CONFIGURATION = "omo-sans-configuration";

export interface OmoRuntimeDeps {
  /** Variables du cockpit ; `env.omo` porte l'adresse et le mot de passe du serveur de la salle (T3c). */
  env: AppEnv;
  log: Logger;
  db: DatabaseSync;
  hub: EventHub;
  /** Suivi des sessions, commun aux deux instances : la colonne `instance` les sépare. */
  sessions: SessionTracker;
  ledger: Ledger;
  archive: ArchiveService;
  classifier: Classifier;
  projects: ProjectsService;
  /** Même compte GitHub Copilot que l'instance principale : le solde et la grille de prix sont ceux du compte (§4.4). */
  copilot?: Pick<CopilotApi, "listModels"> | null;
}

export interface OmoRuntime {
  /** Dépendances d'instance remises au routeur (app-factory), puis au proxy de la salle (L18b). */
  deps: InstanceDeps;
  /** Envois facturés de la salle en vol : compteur PROPRE, jamais lu par la garde de rechargement de l'instance principale. */
  billedInFlight(): number;
  /** Branche le flux d'événements de la salle (après le démarrage 1.1, comme l'instance principale). */
  start(): void;
  /** Arrêt : flux, catalogue et recherche d'agents de la salle. */
  close(): void;
}

/**
 * Construit l'instance de la Salle OMO. Ne lève pas : un serveur de salle injoignable se voit sur le flux (omo.connection), pas
 * ici. Le mot de passe n'est ni journalisé ni recopié (OpencodeClient le masque dans ses messages d'erreur).
 */
export function creerInstanceOmo(deps: OmoRuntimeDeps): OmoRuntime {
  const { env, log, db, hub, sessions, ledger, archive, classifier, projects } = deps;
  const salle = omoOf(env);
  // Environnement de la salle : SON adresse, SON mot de passe, SON dossier de travail, et un dossier de configuration réservé.
  const envSalle: AppEnv = {
    ...env,
    opencodeUrl: salle.url,
    opencodePassword: salle.password,
    opencodeConfigDir: path.join(env.dataDir, OMO_SANS_CONFIGURATION),
  };
  const client = new OpencodeClient(envSalle);
  // Catalogue de la salle : même API Copilot (compte unique), AUCUN onChange — rien ne remonte vers copilotConfig.sync.
  const catalog = new ModelCatalog(client, { ...(deps.copilot ? { copilot: deps.copilot } : {}) });
  const lookup = new OcLookup({ client, env: envSalle, hub, log });
  const gate = createPermissionGate({ client, db, log, hub, sessions, instance: "omo" });
  const processor = new EventProcessor({ db, client, sessions, ledger, archive, classifier, hub, log, instance: "omo" });
  // Client de la salle posé sur les services communs : à partir d'ici, une session « omo » n'est plus jamais demandée ailleurs.
  sessions.useClient("omo", client);
  archive.useClient("omo", client);

  let enVol = 0;
  const instanceDeps: InstanceDeps = {
    instance: "omo",
    client,
    gate,
    lookup,
    catalog,
    processor,
    // Les conditions d'un envoi de la salle (§4.14.2) sont revérifiées par son crochet beforeBilledSend (L22c, L22d) : la file
    // de configuration et l'adresse Copilot de l'instance principale ne refusent JAMAIS un envoi de la salle, et inversement.
    billRefusal: () => null,
    beginBilled: () => {
      enVol++;
      let rendu = false;
      return () => {
        if (rendu) return;
        rendu = true;
        enVol--;
      };
    },
    isAllowedDirectory: (dir) => projects.isAllowedDirectory(dir),
  };

  return {
    deps: instanceDeps,
    billedInFlight: () => enVol,
    start: () => processor.start(),
    close: () => {
      processor.stop();
      catalog.stop();
      lookup.close();
    },
  };
}
