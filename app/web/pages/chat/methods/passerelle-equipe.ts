// Propriétaire : L42c (passerelle posée par la clôture de la 5b, décision A20 : régularisation des balises).
// Ce que la page du chat (fichier partagé de classe A) prend à la CONSTRUCTION dans le dossier des équipes, pour
// [Envoyer à cet assistant] (chemin « aucun ne convient », D-5-13) : la demande recopiée et l'événement du composeur.
// Pourquoi ce module : le contrat de l'itération 4 (web-equipes-slots.test.ts, T4w) n'admet un import du dossier des équipes
// dans la page du chat qu'entre les balises « équipes (it4) », et la convention de la construction (plan it5 §2.6) veut ses
// lignes dans une section c5:, jamais l'une dans l'autre. La page importe donc ce module depuis une section c5: à elle, et le
// bloc d'imports de l'itération 4 reste celui de H4, à l'octet.
// Réexportations seulement : aucun code, aucun effet, aucune requête.
export { demandeRecopiee } from "../team/team-transcript.ts";
export { type ComposeurPrerempli, EVENEMENT_COMPOSEUR } from "../team/team-view-model.ts";
