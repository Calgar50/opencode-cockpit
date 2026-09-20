// Propriétaire : L38a.
// Lanceur d'équipe dans la saisie du chat, juste avant le sélecteur d'autonomie : bouton de menu [Lancer une équipe ▾] et feuille
// de lancement (spécification §7.8 l.1184, §3.13 ; C §9.4 corrigée). Propriétés figées dans ./slots.ts.
// Le lanceur est ABSENT en mode Simple tant que `ouvertesEnSimple` est faux (U1, D-eq-13) ; il est désactivé, avec sa raison
// écrite près du bouton, quand la saisie est vide, quand la conversation travaille ou quand aucune équipe n'est lançable.
// Clavier : motif APG « Menu Button » et « Menu » de server/shared/autonomy-menu.ts (aucun raccourci global, focus jamais volé,
// focus rendu au bouton à la fermeture du menu comme à celle de la feuille). Toute la logique est dans ./launch-sheet-model.ts
// (D-eq-24) et tous les textes dans server/shared/team-texts.ts (T4t).
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { buttonKey, menuKey, openingIndex } from "../../../../server/shared/autonomy-menu.ts";
import { Icon } from "../../../components/Icon.tsx";
import { errorText } from "../../../lib/api.ts";
import { teamsApi } from "../../../lib/api-teams.ts";
import type { TeamsListResponse, TeamView } from "../../../lib/types.ts";
import { vueLanceur } from "./launch-sheet-model.ts";
import type { TeamLauncherProps } from "./slots.ts";
import { TeamLaunchSheet } from "./TeamLaunchSheet.tsx";
import "./team-launch.css";

export function TeamLauncher({ rootId, directory, advanced, busy, getDraft, clearDraft, agentConversation, onLaunched }: TeamLauncherProps) {
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const [liste, setListe] = useState<TeamsListResponse | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const [focalise, setFocalise] = useState(-1);
  /** Équipe dont la feuille de lancement est ouverte ; null : aucune feuille. */
  const [choisie, setChoisie] = useState<TeamView | null>(null);
  /**
   * La saisie ne porte aucune demande. Le brouillon vit dans la saisie (Composer, figé par T4w) : il n'émet rien à chaque frappe,
   * et il est relu ici quand le pointeur ou le focus arrive sur le lanceur, puis à chaque clic. Il n'est jamais gardé.
   */
  const [demandeVide, setDemandeVide] = useState(() => getDraft().texte === "");

  const boutonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  // GET /api/teams : équipes installées, exemples et `ouvertesEnSimple`. Un échec laisse le lanceur absent, jamais une liste supposée.
  useEffect(() => {
    const controller = new AbortController();
    teamsApi.list(controller.signal).then(
      (reponse) => setListe(reponse),
      (err: unknown) => {
        if (!controller.signal.aborted) console.warn("équipes : liste illisible", errorText(err));
      },
    );
    return () => controller.abort();
  }, []);

  /** Relecture du brouillon (pointeur ou focus sur le lanceur, clic) : la saisie vide désactive le lanceur avec sa raison. */
  const relireBrouillon = useCallback(() => setDemandeVide(getDraft().texte === ""), [getDraft]);

  const vue = vueLanceur({ liste, advanced, busy, demandeVide });

  const fermerMenu = useCallback(() => {
    setOuvert(false);
    setFocalise(-1);
    boutonRef.current?.focus();
  }, []);

  const ouvrirMenu = (index: number | null) => {
    setOuvert(true);
    setFocalise(index ?? -1);
  };

  useEffect(() => {
    if (!ouvert) return;
    const cible = focalise >= 0 ? itemRefs.current[focalise] : menuRef.current;
    cible?.focus();
  }, [ouvert, focalise]);

  const activer = (index: number) => {
    const item = vue.items[index];
    if (item === undefined || !item.lancable) return;
    const equipe = liste?.teams.find((team) => team.id === item.id) ?? null;
    if (equipe === null) return;
    setOuvert(false);
    setFocalise(-1);
    setChoisie(equipe);
  };

  const toucheBouton = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    relireBrouillon();
    const index = buttonKey(event.key, vue.items.length);
    if (index === null || !vue.actif) return;
    event.preventDefault();
    ouvrirMenu(index);
  };

  const toucheMenu = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const effet = menuKey(
      vue.items.map((item) => item.titre),
      focalise,
      event.key,
    );
    if (effet.kind === "none") return;
    if (effet.kind === "close") {
      // Tab et Maj+Tab : le focus revient au bouton, puis la tabulation du navigateur part de lui.
      if (!effet.keepDefault) event.preventDefault();
      fermerMenu();
      return;
    }
    event.preventDefault();
    if (effet.kind === "focus") setFocalise(effet.index);
    else activer(effet.index);
  };

  /** Fermeture de la feuille : le lanceur reprend le focus (aucun focus volé, spécification §5.5). */
  const fermerFeuille = useCallback(() => {
    setChoisie(null);
    boutonRef.current?.focus();
  }, []);

  if (!vue.visible) return null;

  const raisonId = `${baseId}-raison`;
  return (
    <div
      className="team-launcher"
      onPointerEnter={relireBrouillon}
      onFocusCapture={relireBrouillon}
      onBlur={(event) => {
        // Focus parti hors du lanceur (tabulation, clic ailleurs) : le menu se ferme sans reprendre le focus.
        if (ouvert && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOuvert(false);
          setFocalise(-1);
        }
      }}
    >
      <button
        ref={boutonRef}
        type="button"
        className="btn sm ghost team-launcher-bouton"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        aria-controls={ouvert ? menuId : undefined}
        aria-describedby={vue.raison ? raisonId : undefined}
        aria-disabled={vue.actif ? undefined : true}
        onClick={() => {
          // Bouton inactif : le brouillon est relu (la saisie a pu changer depuis), aucun menu ne s'ouvre.
          relireBrouillon();
          if (!vue.actif) return;
          if (ouvert) fermerMenu();
          else ouvrirMenu(openingIndex(vue.items.length));
        }}
        onKeyDown={toucheBouton}
      >
        <Icon name="users" size={14} />
        <span className="ellipsis">{vue.libelle}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {vue.raison ? (
        <span id={raisonId} className="team-launcher-raison">
          {vue.raison}
        </span>
      ) : null}
      {ouvert ? (
        <div ref={menuRef} id={menuId} role="menu" tabIndex={-1} aria-label={vue.libelle} className="team-launcher-menu" onKeyDown={toucheMenu}>
          {vue.items.map((item, index) => (
            <div
              key={item.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              role="menuitem"
              tabIndex={-1}
              className="team-launcher-item"
              aria-disabled={item.lancable ? undefined : true}
              aria-posinset={index + 1}
              aria-setsize={vue.items.length}
              onClick={() => activer(index)}
              onFocus={() => setFocalise(index)}
            >
              <span className="team-launcher-item-titre">{item.titre}</span>
              <span className="team-launcher-item-detail">{item.sousTitre}</span>
              {item.raison ? (
                <span className="team-launcher-item-raison">
                  <Icon name="lock" size={12} />
                  {item.raison}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {choisie !== null ? (
        <TeamLaunchSheet
          equipe={choisie}
          rootId={rootId}
          directory={directory}
          advanced={advanced}
          busy={busy}
          agentConversation={agentConversation}
          getDraft={getDraft}
          clearDraft={clearDraft}
          onLaunched={onLaunched}
          onClose={fermerFeuille}
        />
      ) : null}
    </div>
  );
}
