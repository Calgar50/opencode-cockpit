// Propriétaire : L3.
// Plancher de conversation (spécification §3.4) : empreinte SHA-256, crochets createSession, sessionCreated et beforeBilledSend,
// ports verified et createWithFloor ; écart → DELETE de la session et 502 plancher-non-verifie (D-04).
// Squelette T0 : aucune inscription ; port neutre = 1.0.4 (aucun plancher posé ni vérifié).
// neutralFloors reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { type Cockpit11Module, type FloorsPort, PortUnavailableError } from "./contracts-11.ts";

export function neutralFloors(): FloorsPort {
  return {
    verified: async () => false,
    createWithFloor: async () => {
      throw new PortUnavailableError("floors");
    },
  };
}

export const floorsModule: Cockpit11Module = {
  name: "floors",
  install() {
    // Squelette : L3 pose c11.ports.floors et les crochets « createSession », « sessionCreated », « beforeBilledSend ».
  },
};
