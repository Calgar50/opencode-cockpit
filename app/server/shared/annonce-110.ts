// Annonce de la version 1.1.0 (L51 ; plan it5 §4.3 et §8.7 L51, D-5-16, D-5-24 ; conception C §9.14, corrigée au plan it5
// §1.3 ; fiche de la migration du web §7 ; décisions U1 et A37). Affichée une fois, dans le chat et dans Assistants, par
// FirstRunRules.tsx, qui l'enregistre dans ui.noticeSeen (UPGRADE_NOTICE_VERSION).
// Module PUR : ni réseau, ni horloge, ni réglage lu ici. L'appelant passe le mode et `ouvertesEnSimple`, lu par GET /api/teams
// (client api-teams.ts de l'itération 4) ; `null` tant que la lecture n'a pas répondu ou si elle échoue.
// Règles, chacune tenue par annonce-110.test.ts :
// - la phrase d'équipe n'est proposée que là où les équipes sont ouvertes dans le mode courant : equipesOuvertes de
//   shared/equipes-ouvertes.ts (GF5), reprise SANS redéfinition ; en mode Simple, tant qu'EQUIPES_SIMPLE_OUVERTES vaut false,
//   aucune équipe n'est proposée, et une lecture en échec ferme (fermé en cas de doute) ;
// - les deux variantes sont assemblées par annonceMiseAJour (construction-texts.ts), jamais recomposées ici ;
// - le paragraphe « Internet » vaut pour les deux modes ; la phrase technique (outils, copie .avant-1.1.0) n'est ajoutée qu'en
//   mode Avancé : en mode Simple, ni webfetch, ni websearch, ni D11, ni « volume ».
import type { UiMode } from "./assistant-rules.ts";
import { annonceMiseAJour, TEXTES } from "./construction-texts.ts";
import { equipesOuvertes } from "./equipes-ouvertes.ts";

/** Contenu de l'annonce : un titre, un texte, puis le paragraphe « Internet », et les deux boutons [Voir la carte] [Compris]. */
export interface Annonce110 {
  titre: string;
  texte: string;
  /** Paragraphe « Internet » : la phrase des deux modes, suivie en mode Avancé de la phrase technique. */
  internet: readonly string[];
  voirCarte: string;
  compris: string;
  /** Nom accessible de la région de l'annonce. */
  region: string;
}

/** Annonce de la 1.1.0 pour ce mode et cette lecture de `ouvertesEnSimple` (null : lecture absente, en cours ou en échec). */
export function annonce110(mode: UiMode, ouvertesEnSimple: boolean | null): Annonce110 {
  const annonce = TEXTES.partout.annonce;
  const { titre, texte } = annonceMiseAJour({ equipesOuvertes: equipesOuvertes(mode, ouvertesEnSimple) });
  const internet = mode === "avance" ? [annonce.web, TEXTES.avance.annonce.web] : [annonce.web];
  return { titre, texte, internet, voirCarte: annonce.voirCarte, compris: annonce.compris, region: annonce.region };
}
