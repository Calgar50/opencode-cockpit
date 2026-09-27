// Propriétaire : L29d.
// Scène 3D de la salle de contrôle (spécification §5.8 l.996-998 ; §5.5 l.923-924 ; plan d'exécution it3, fiche L29d, JP-11,
// JP-12, D-3d-05, D-3d-17, D-3d-19, D-3d-28). Propriétés FIGÉES dans ./slots-3d.ts : la page (L31b) et le zoom (L31c) ne
// consomment que ce contrat.
// - Le canevas est `aria-hidden` : la vérité reste la liste et le tableau de la page (§5.8 l.998, P7). Seules les étiquettes DOM
//   posées par-dessus sont focalisables (Etiquettes3d, 60 au plus, D-3d-19).
// - three n'est atteint QUE par ./moteur-chargeur.ts (import dynamique, seule frontière, D-3d-05) : le morceau reste paresseux,
//   aucune entrée ne touche three statiquement (garde du build, JP-11). Le moteur (L29c) n'est consommé que par cette fabrique
//   et par l'interface `Moteur`, jamais par son implémentation.
// - Contexte WebGL refusé (`creerMoteur` rend null) ou morceau impossible à charger : onEchec("contexte-refuse"), et la page
//   passe en 2D. Une perte de contexte NON demandée est relayée telle quelle par le moteur : onEchec("contexte-perdu").
// - LIBÉRATION (D-3d-28) au démontage ET au changement de zoom, de thème ou de réglage de mouvement : le moteur est refait,
//   l'ancien rend ses géométries, ses textures et son contexte. Cette libération est VOLONTAIRE : elle n'appelle jamais
//   onEchec, donc ne bascule jamais la page en 2D (le moteur pose son drapeau `libere` avant `forceContextLoss`).
// - Aucune requestAnimationFrame, aucune minuterie ici (salle3d-animations.test.ts) : les images viennent du moteur, qui n'en
//   demande que quand la scène s'anime (D-3d-17) ; le redimensionnement vient d'un ResizeObserver.
import { type CSSProperties, useCallback, useEffect, useMemo, useRef } from "react";
import type { Point3 } from "../../../server/shared/salle3d-types.ts";
import { Etiquettes3d } from "./Etiquettes3d.tsx";
import type { PositionEcran } from "./etiquettes-3d.ts";
import { chargerMoteur } from "./moteur-chargeur.ts";
import type { Moteur, Scene3dHandle, Scene3dProps } from "./slots-3d.ts";

/** « Suivre l'action » : translation de caméra en 1 s au plus (spécification §5.8 l.1000). */
const SUIVI_MS = 1000;

/** Densité de pixels bornée : au-delà, le coût de rendu monte sans gain visible sur un écran de bureau. */
const RATIO_MAX = 2;

/** Position rendue tant qu'aucun moteur n'existe : hors champ, donc étiquettes masquées. */
const HORS_CHAMP: PositionEcran = Object.freeze({ x: 0, y: 0, visible: false });

const SCENE: CSSProperties = { position: "relative", width: "100%", height: "100%", overflow: "hidden" };
const CANEVAS: CSSProperties = { display: "block", width: "100%", height: "100%" };

export function Scene3d(props: Scene3dProps) {
  const { plan, mouvementReduit, suivre, onSelect } = props;
  const conteneurRef = useRef<HTMLDivElement>(null);
  const canevasRef = useRef<HTMLCanvasElement>(null);
  const moteurRef = useRef<Moteur | null>(null);
  const planRef = useRef(plan);
  /** Rappels de la page, relus à chaque appel : le moteur vit plus longtemps qu'une image React. */
  const rappelsRef = useRef(props);
  /** Abonnés aux images du moteur (Etiquettes3d) : replacés sans nouvelle image React. */
  const abonnesRef = useRef(new Set<() => void>());

  useEffect(() => {
    rappelsRef.current = props;
  });

  const abonnerImage = useCallback((replacer: () => void) => {
    const abonnes = abonnesRef.current;
    abonnes.add(replacer);
    return () => {
      abonnes.delete(replacer);
    };
  }, []);

  const projeter = useCallback((point: Point3) => moteurRef.current?.projeter(point) ?? HORS_CHAMP, []);

  const redimensionner = useCallback(() => {
    const moteur = moteurRef.current;
    const conteneur = conteneurRef.current;
    if (moteur === null || conteneur === null) return;
    const densite = window.devicePixelRatio;
    const ratio = Math.min(Number.isFinite(densite) && densite > 0 ? densite : 1, RATIO_MAX);
    moteur.redimensionner(conteneur.clientWidth, conteneur.clientHeight, ratio);
  }, []);

  /** Poignée rendue à la page (onReady) : stable, elle suit le moteur du moment (sonde de fluidité, mesure, libération). */
  const poignee = useMemo<Scene3dHandle>(
    () => ({
      renderFrame: () => {
        moteurRef.current?.renderFrame();
      },
      info: () => moteurRef.current?.info() ?? { geometries: 0, textures: 0 },
      liberer: () => {
        const moteur = moteurRef.current;
        moteurRef.current = null;
        moteur?.liberer();
      },
    }),
    [],
  );

  // Moteur : créé au montage, refait à chaque changement de zoom, de thème ou de réglage de mouvement ; libéré à chaque fois.
  const zoom = plan.zoom;
  const theme = plan.theme;
  useEffect(() => {
    const canevas = canevasRef.current;
    if (canevas === null) return;
    let vivant = true;
    chargerMoteur().then(
      ({ creerMoteur }) => {
        if (!vivant) return;
        const moteur = creerMoteur(canevas, {
          theme,
          mouvementReduit,
          onFrame: (ms, anime) => rappelsRef.current.onFrame?.(ms, anime),
          onImage: () => {
            for (const replacer of [...abonnesRef.current]) replacer();
          },
          onEchec: (raison) => rappelsRef.current.onEchec(raison),
        });
        if (moteur === null) {
          // Contexte WebGL refusé : la page passe en 2D (JP-12), sans monter la scène.
          rappelsRef.current.onEchec("contexte-refuse");
          return;
        }
        moteurRef.current = moteur;
        redimensionner();
        moteur.afficher(planRef.current);
        rappelsRef.current.onReady?.(poignee);
      },
      () => {
        // Morceau paresseux impossible à charger : même issue qu'un contexte refusé, jamais un écran vide.
        if (vivant) rappelsRef.current.onEchec("contexte-refuse");
      },
    );
    return () => {
      vivant = false;
      const moteur = moteurRef.current;
      moteurRef.current = null;
      // Libération VOLONTAIRE (D-3d-28) : le moteur n'appelle pas onEchec, la page ne bascule pas en 2D.
      moteur?.liberer();
    };
  }, [zoom, theme, mouvementReduit, redimensionner, poignee]);

  // Nouveau plan : une image, et seulement à ce moment-là (rendu à la demande, D-3d-17).
  useEffect(() => {
    planRef.current = plan;
    moteurRef.current?.afficher(plan);
  }, [plan]);

  // « Suivre l'action » (différé seulement, décidé par le zoom) : translation de caméra bornée à 1 s.
  useEffect(() => {
    if (suivre === null) return;
    moteurRef.current?.suivre(suivre, SUIVI_MS);
  }, [suivre]);

  useEffect(() => {
    const conteneur = conteneurRef.current;
    if (conteneur === null) return;
    const observateur = new ResizeObserver(redimensionner);
    observateur.observe(conteneur);
    return () => observateur.disconnect();
  }, [redimensionner]);

  return (
    <div ref={conteneurRef} className="salle3d-scene" style={SCENE}>
      <canvas ref={canevasRef} aria-hidden="true" className="salle3d-canevas" style={CANEVAS} />
      <Etiquettes3d etiquettes={plan.etiquettes} theme={theme} projeter={projeter} abonnerImage={abonnerImage} onSelect={onSelect} />
    </div>
  );
}
