// Propriétaire : L39b.
// Carte des assistants (spécification §5.2, §5.4 ; plan d'exécution it4, fiche L39b) : route GET /api/agent-map et vues Centrée et
// Liste, sur le module pur shared/agent-map.ts (L39a). Module sans port (routes seulement, groupe « agent-map »).
// Squelette T4 : aucune inscription.
import type { EqModule } from "./contracts-eq.ts";

export const agentMapModule: EqModule = {
  name: "agentMap",
  install() {
    // Squelette : L39b pose le groupe de routes « agent-map » (routes-agent-map.ts).
  },
};
