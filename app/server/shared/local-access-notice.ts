// Accès local vu par l'interface : module PUR (aucun import « node: », aucun accès au DOM).
//
// Trois décisions du plan 1.0.5, réunies ici pour être testées sans navigateur :
// - quel bandeau « connexion locale non chiffrée » afficher (I6 : mode HTTP visible partout, jamais masquable) ;
// - quel écran de connexion proposer (I5 : en mode HTTP, le jeton ne se saisit jamais dans une page) ;
// - quel message afficher après un retour de /auth (§3.6.6).
import type { LocalScheme } from "./api-types.ts";

/**
 * - « http-choisi » : le cockpit sert bien le mode HTTP confirmé à l'installation, avec la date de la confirmation.
 * - « page-http » : la page est servie en clair sans date exploitable (écran de connexion, ou `.env` modifié à la main).
 */
export type LocalAccessNotice = { kind: "http-choisi"; confirmedAt: string } | { kind: "page-http" };

/** Écran de connexion : saisie du jeton (HTTPS) ou ouverture par les scripts seulement (page en clair). */
export type LoginMode = "jeton" | "open-seulement";

/**
 * Même expression que `isValidConfirmedAt` (server/env.ts) et que `Get-CockpitLocalMode` (CockpitTls.ps1), vérifiée par les
 * vecteurs communs `tests/vectors/local-access.json` : l'interface ne peut pas importer env.ts (il charge « node: »), et un test
 * croisé compare les deux fonctions.
 */
const CONFIRMED_AT = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;

/** Date de confirmation affichable : expression stricte, puis aller-retour (Date.parse accepte le 30 février). */
export function isDisplayableConfirmedAt(at: string | null | undefined): at is string {
  if (typeof at !== "string" || !CONFIRMED_AT.test(at)) return false;
  const date = new Date(at);
  // Finitude d'abord : toISOString lève RangeError sur une date invalide.
  return Number.isFinite(date.getTime()) && date.toISOString() === `${at.slice(0, 19)}.000Z`;
}

/**
 * Bandeau à afficher, ou null (HTTPS de bout en bout). Un mode HTTP confirmé donne sa date ; une page servie en clair sans date
 * valable reste signalée, sans jamais afficher la valeur lue.
 */
export function localAccessNotice(input: { scheme: LocalScheme; confirmedAt: string | null; protocol: string }): LocalAccessNotice | null {
  if (input.scheme === "http" && isDisplayableConfirmedAt(input.confirmedAt)) {
    return { kind: "http-choisi", confirmedAt: input.confirmedAt };
  }
  if (input.protocol.toLowerCase() === "http:") return { kind: "page-http" };
  return null;
}

/** Page en clair : aucun champ de jeton (il circulerait en clair) ; le serveur refuse de toute façon POST /api/login. */
export function loginMode(protocol: string): LoginMode {
  return protocol.toLowerCase() === "https:" ? "jeton" : "open-seulement";
}

const AUTH_ERRORS: Readonly<Record<string, string>> = {
  failed: "Lien de connexion invalide, expiré ou déjà utilisé : relancez .\\cockpit.ps1 open.",
  "ancien-lien": "Lien d'une ancienne version : relancez .\\cockpit.ps1 open.",
};

/** Message du retour de /auth (`?auth=…`) : chaîne vide si l'adresse n'en porte pas. */
export function authErrorText(search: string): string {
  const code = new URLSearchParams(search).get("auth");
  if (code === null) return "";
  return AUTH_ERRORS[code] ?? "Connexion impossible : relancez .\\cockpit.ps1 open.";
}
