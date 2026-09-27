// Propriétaire : L49.
// Démonstration d'équipe enregistrée (spécification §5.3 l.896, §5.4 l.909, §5.9 l.1013-1017, §6 l.1064, JP-9 ; D-5-15) :
// le déroulé « Avis indépendants » joué à l'avance par l'exécuteur de l'itération 4 sur le faux opencode
// (server/test-support/gen-demo-equipe.ts) est rejoué moment par moment dans le lecteur pas à pas de la démonstration passée
// (DemoPlayer, propriété `demo` ; depuis la grande fusion GF4, avec les mots de « Revoir », le lecteur de l'itération 1 ayant
// été remplacé par la 3D), qui dessine la bande néon ; sous la bande, la carte d'exécution et le Déroulé de l'itération 4.
// - AUCUNE IA appelée, AUCUNE requête : tout vient de `demo-equipe.json`, livré avec l'interface, lu par demo-equipe-source.tsx
//   (sorti d'ici par GF5 : le choix du lecteur complet le lit aussi). Ni client de l'API (web/lib/api*.ts), ni proxy, ni fetch :
//   seulement des modèles PURS (team-view-model.ts, deroule-model.ts) et les textes de la construction (demo-equipe.test.ts le
//   vérifie par un examen statique des imports).
// - Données FICTIVES : l'équipe, ses étapes, ses assistants et leurs réponses sont inventés, et les heures sont celles des
//   moments, pas celles d'un enregistrement réel. La ligne « Déroulé enregistré avec des données fictives. » le dit.
// - Pas à pas : le curseur, [Moment précédent] et [Moment suivant] du lecteur, en « n / N » — jamais le mot « étape »,
//   réservé aux étapes de l'équipe. AUCUNE lecture automatique. Les transitions de la bande sont celles de NeonCarte (NeonBand,
//   `useTransitions`, environ 900 ms à chaque signe qui apparaît ou change d'un moment à l'autre) : le mouvement réduit les coupe.
// - Mode Simple : ce composant n'est monté que par l'onglet Équipes, qui suit l'ouverture des équipes dans le mode courant (U1,
//   D-5-24) et passe `equipesVisibles` au lecteur (GF5). Il ne lit lui-même AUCUN réglage.
// - Accessibilité : la boîte, le curseur et le tableau sont ceux du lecteur ; l'état de chaque étape est dit par son MOT à côté
//   de son icône, jamais par la couleur seule, et les barres du Déroulé sont décoratives (leur durée est écrite à côté).
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import { DemoPlayer } from "../../chat/activity/DemoPlayer.tsx";
import { ContenuDemoEquipe, FAITS_EQUIPE, INSTANTS_EQUIPE, MOMENTS_EQUIPE } from "./demo-equipe-source.tsx";

const T = TEXTES.partout.demonstration;

export interface TeamDemoProps {
  /** Mode de l'utilisateur, passé au lecteur et aux modèles de l'itération 4. */
  advanced: boolean;
  // <c5:demonstration-equipe-visible>
  /**
   * GF5 : ouverture des équipes dans le mode courant (equipesOuvertes, calculée par l'onglet), passée telle quelle au lecteur.
   * Le lecteur de la démonstration passée ne montre pas le choix du lecteur complet : la valeur n'y change rien, elle suit le
   * contrat de DemoPlayer (l'appelant décide, le lecteur ne lit rien). Absente : faux.
   */
  equipesVisibles?: boolean;
  // </c5:demonstration-equipe-visible>
  onClose: () => void;
}

/** Démonstration d'équipe : le lecteur de la démonstration passée, nourri par la fixture, avec la carte et le Déroulé sous la bande. */
export function TeamDemo({ advanced, equipesVisibles = false, onClose }: TeamDemoProps) {
  return (
    <DemoPlayer
      advanced={advanced}
      equipesVisibles={equipesVisibles}
      onClose={onClose}
      demo={{
        titre: T.titre,
        faits: FAITS_EQUIPE,
        moments: INSTANTS_EQUIPE,
        rendre: ({ rang }) => <ContenuDemoEquipe moment={MOMENTS_EQUIPE[Math.min(Math.max(rang, 0), MOMENTS_EQUIPE.length - 1)] ?? null} advanced={advanced} />,
      }}
    />
  );
}
