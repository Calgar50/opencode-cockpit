// Ports que fetch refuse : partagé par le serveur (adresse d'opencode) et les tests (ports d'écoute du faux opencode et du cockpit).

/**
 * Ports que fetch refuse sans rien envoyer (« bad port », Fetch Standard, port blocking ; badPorts d'undici, liste de Node 24.15).
 * Plage dynamique de Windows ouverte dès 1024 (Hyper-V, Docker) : listen(0) peut rendre l'un des 19 ports bloqués au-delà de 1024.
 * Chaque requête du client échouerait alors (« fetch failed »), et subscribeGlobal réessaierait sans jamais se connecter.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Port que fetch refuse sans rien envoyer : une adresse sur ce port ne répondrait jamais (« fetch failed »). */
export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}
