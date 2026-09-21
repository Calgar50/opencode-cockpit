// Propriétaire : L18c.
// Salles de la Salle OMO (spécification §3.9, §3.10, §7.1 l.1084 ; plan 2 bis, fiche L18c) : port `omoRoom` (ouverture d'une
// salle, statut, projets ouverts, appartenance d'une racine) et montage du groupe de routes « omo ».
// SQUELETTE posé par T3b (plan 2 bis §4.2) : port NEUTRE (salle coupée) et une seule inscription, le groupe de routes, qui pose
// la garde 403 « salle-coupee » de routes-omo.ts. Aucun comportement de salle : rien n'est lu, rien n'est écrit, aucune racine
// n'appartient à la salle. L'inscription porte `instances: ["omo"]` : c'est une inscription de la salle (D-2b-40).
// `neutralOmoRoom` reste exporté et inchangé quand L18c arrivera : c'est le port des tests qui ne déclarent pas ce module.
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import type { OmoRoomPort } from "./omo-contracts.ts";
import { registerOmoRoutes } from "./routes-omo.ts";

export function neutralOmoRoom(deps: Cockpit11Deps): OmoRoomPort {
  return {
    open: async () => ({ ok: false, status: 403, code: "salle-coupee", precheck: null }),
    // Salle coupée : aucun relevé n'est deviné. `omo` et `salleOuverte` sont faux ; `autonomie` est la seule chose que le
    // cockpit sache de lui-même. Les vrais relevés (image, démarrage, egress, battement) arrivent avec L18c.
    status: async () => ({
      interrupteurs: { omo: false, autonomie: deps.env.autonomy, salleOuverte: false },
      image: { chargee: false, id: null, manifesteSha256: null, version: null, auditeLe: null },
      dernierDemarrage: null,
      listeBlanche: [],
      projetsPrepares: [],
      workspaceGit: null,
      etatSalle: "coupee",
      authSalle: { presente: false },
      sortiesRefusees24h: [],
      battement: { actif: false, ageMs: null },
    }),
    openProjects: () => [],
    isRoomRoot: () => false,
  };
}

export const omoRoomModule: Cockpit11Module = {
  name: "omoRoom",
  install(reg, c11) {
    reg.routes("omo", (app) => registerOmoRoutes(app, c11), { instances: ["omo"] });
  },
};
