// Propriétaire : T3b.
// Branchement du service de contrôle de la Salle OMO (L17b, omo-control.ts) au câblage 1.1 (plan 2 bis §4.2, §2.7 ; spéc.
// §3.12.1, §3.15.2 ; D-2b-25, D-2b-26, D-2b-29). C'est le SEUL module de la salle dont le port n'est pas un squelette : le
// service réel est posé, et il est inerte tant que la salle est coupée.
//
// - `actif()` (relu à CHAQUE écriture par le service) = COCKPIT_OMO=on ET COCKPIT_AUTONOMY=on ET SALLE_OUVERTE. Ici :
//   · COCKPIT_OMO=on est porté par la PRÉSENCE de `omoControlDirs` (le cockpit ne connaît les volumes de la salle que si elle
//     est configurée) : ce module ne lit aucune variable d'environnement ; `env.omo` (T3c) y sera relié par l'intégrateur au
//     train de V2 ;
//   · COCKPIT_AUTONOMY=on est `env.autonomy` ;
//   · SALLE_OUVERTE est `c11.salleOuverte`, faux dans le dépôt (plan 2 bis §2.7).
//   Il s'ensuit que, dans le dépôt, AUCUN battement, AUCUN precheck-ok, AUCUN guard-state.json et AUCUN omo-auth/auth.json ne
//   sont écrits, jamais — et rien n'est écrit non plus quand les dossiers sont absents, puisque le service n'est pas construit.
// - `omoControlDirs` absent ou null : le port NEUTRE reste en place (aucun fichier touché) et le module n'inscrit rien.
// - Avec les dossiers, l'inscription de démarrage appelle `publishAuth()` — qui, salle coupée, RETIRE la copie d'`auth.json`
//   laissée par un cockpit précédent (demande n° 3 de L17b, constats-salle-V1 §2.3) — puis `readState()`, lecture bornée de
//   l'état publié par le superviseur, puis `startHeartbeat()` (train de V4 de la 2 ter, constats de L23b et L21b : sans cet
//   appel, aucun code de production ne lançait le battement, et le superviseur, qui n'ouvre rien sans lui, ne lançait jamais
//   opencode). Salle coupée, le service ne bat pas (actif() faux) et le dit une fois : aucune écriture dans les volumes de la
//   salle. Un échec de `publishAuth` arrête l'étape AVANT le battement : sans authentification publiée, rien ne démarre.
// - Cette inscription de démarrage porte `instances: ["principale"]` : elle tourne côté COCKPIT, pas dans la salle. C'est la
//   SEULE exception au test de propriété de wiring-11.test.ts (D-2b-40), qui exige `["omo"]` pour toutes les autres
//   inscriptions des modules `omo*`. Les méthodes sont lues sur `c11.ports.omoControl` au moment de l'appel, jamais en
//   copie : une surcharge de port (tests) ou un port posé plus tard reste pris en compte.
import type { Cockpit11Deps, Cockpit11Module, OmoControlDirs } from "./contracts-11.ts";
import { createOmoControl } from "./omo-control.ts";
import type { OmoControlPort } from "./omo-contracts.ts";

/**
 * Port neutre : le service réel n'est pas construit (salle non configurée). Rien n'est écrit, rien n'est lu, aucun dossier n'est
 * créé ; l'état du superviseur est « inconnu » (fermé en cas de doute) et la salle n'est jamais suspendue par ce port.
 */
export function neutralOmoControl(_deps: Cockpit11Deps): OmoControlPort {
  return {
    startHeartbeat: () => undefined,
    stopHeartbeat: () => undefined,
    requestStop: async () => undefined,
    writePrecheckOk: async () => undefined,
    writeGuardState: async () => undefined,
    publishAuth: async () => undefined,
    readState: async () => null,
    suspend: () => undefined,
    resume: () => undefined,
    suspended: () => false,
  };
}

/** Dossiers de contrôle lus sur les dépendances ; absents ou null : salle non configurée. */
function dirsOf(deps: Cockpit11Deps): OmoControlDirs | null {
  return deps.omoControlDirs ?? null;
}

export const omoControlModule: Cockpit11Module = {
  name: "omoControl",
  install(reg, c11) {
    const dirs = dirsOf(c11);
    if (dirs === null) return;
    c11.ports.omoControl = createOmoControl({
      controlDir: dirs.controlDir,
      stateDir: dirs.stateDir,
      authDir: dirs.authDir,
      opencodeDataDir: dirs.opencodeDataDir,
      // Suspension gardée hors des volumes de la salle, dans le dossier de données du cockpit (D-2b-29).
      cockpitDataDir: c11.env.dataDir,
      projectsFile: dirs.projectsFile ?? null,
      actif: () => c11.salleOuverte && c11.env.autonomy,
      log: c11.log,
    });
    reg.startup(
      async () => {
        await c11.ports.omoControl.publishAuth();
        await c11.ports.omoControl.readState();
        c11.ports.omoControl.startHeartbeat();
      },
      { instances: ["principale"] },
    );
  },
};
