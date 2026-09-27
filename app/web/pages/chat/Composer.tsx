// Zone de saisie : assistant, message, fichiers (@), raccourcis (/), images collées, IA de la demande et
// bandeau de confidentialité permanent.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { MESSAGES } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button } from "../../components/ui.tsx";
import { oc } from "../../lib/api.ts";
// <c5:methodes-import>
// Itération 5 (L44e) : puce « + Méthode », méthodes retenues et aperçu modifiable du bloc ajouté au message (D-5-08).
// Les phrases de refus viennent du module pur (§4.3) : aucune n'est réécrite ici.
import { methodChipReason } from "../../../server/shared/chat-methods-view.ts";
// L44f : phrase « Les méthodes d'une équipe se règlent sur ses étapes. » (§4.3), prise au module de textes, jamais réécrite.
import { TEXTES as TEXTES_C5 } from "../../../server/shared/construction-texts.ts";
import { type ChosenMethod, MethodChip, MethodChipList } from "./methods/MethodChip.tsx";
// </c5:methodes-import>
// <c5:salle-import>
import { outilsDeConstruction } from "../../../server/shared/construction-salle.ts";
// </c5:salle-import>
import type { ComposerSlots } from "./slots.ts";
import type { CommandOption } from "./turn.ts";
// --- équipes (it4) : début ---
import { type RefObject, useImperativeHandle } from "react";
import type { TeamDraft } from "./team/slots.ts";
// --- équipes (it4) : fin ---

export interface ComposerAttachment {
  id: string;
  kind: "image" | "file";
  filename: string;
  mime: string;
  url: string;
}

export interface ComposerSubmit {
  text: string;
  attachments: ComposerAttachment[];
}

/** Assistant sélectionnable (titre affiché, aide en infobulle). */
export interface AgentOption {
  name: string;
  title: string;
  help: string | null;
}

// --- équipes (it4) : début ---
/** Brouillon de la saisie, lu et vidé par le lanceur d'équipe (ChatPage le relie à TeamLauncher : getDraft, clearDraft). */
export interface ComposerDraftHandle {
  get(): TeamDraft;
  clear(): void;
}

/** Brouillon transmis à une équipe : texte sans espaces autour ; fichiers joints par « @ » encore cités (même règle que l'envoi), jamais d'image. */
function teamDraftOf(text: string, attachments: readonly ComposerAttachment[]): TeamDraft {
  const texte = text.trim();
  const fichiers = attachments.filter((a) => a.kind === "file" && texte.includes(`@${a.filename}`)).map((a) => a.filename);
  return { texte, fichiers };
}

// --- équipes (it4) : fin ---
interface MenuItem {
  value: string;
  label: string;
  hint?: string;
}

interface Menu {
  kind: "file" | "command";
  query: string;
  start: number;
  items: MenuItem[];
  index: number;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function fileUrl(directory: string, path: string): string {
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${directory.replace(/[\\/]+$/, "")}/${path}`;
  const normalized = absolute.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("lecture impossible"));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  directory,
  busy,
  disabled = false,
  placeholder,
  agents,
  agent,
  agentTitle,
  onAgentChange,
  commands,
  onCommandChange,
  imageModel,
  ia,
  notice,
  onSubmit,
  onAbort,
  seed,
  autonomy,
  stopVisible = false,
  // --- équipes (it4) : début ---
  team,
  draftHandle,
  // --- équipes (it4) : fin ---
  salle = false, // c5 : GF5, racine de la Salle OMO
}: ComposerSlots & {
  directory: string;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string | undefined;
  agents: AgentOption[];
  agent: string;
  /** Titre de l'assistant courant (s'il n'est pas dans la liste). */
  agentTitle: string;
  onAgentChange: (name: string) => void;
  /** Lignes du menu « / » (déjà filtrées selon le mode). */
  commands: CommandOption[];
  /** Nom tapé après « / » en tête du message (null sinon), pour afficher l'IA du raccourci. */
  onCommandChange?: (name: string | null) => void;
  /** IA qui recevra le message (vérification des images). */
  imageModel?: { name: string; attachment: boolean } | undefined;
  /** Choix de l'IA (puce, niveaux, réflexion, coût). */
  ia?: ReactNode;
  /** Message au-dessus de la zone (problème bloquant). */
  notice?: ReactNode;
  /** false (ou promesse de false) : rien n'a été envoyé, le texte est remis dans la zone. */
  onSubmit: (input: ComposerSubmit) => Promise<boolean> | boolean | void;
  onAbort: () => void;
  /** Texte à insérer ; `nonce` change à chaque insertion. */
  seed?: { text: string; nonce: number } | undefined;
  // --- équipes (it4) : début ---
  /** Lanceur d'équipe (TeamLauncher), rendu juste avant le sélecteur d'autonomie. */
  team?: ReactNode;
  /** Reçoit la lecture et l'effacement du brouillon (lanceur d'équipe). */
  draftHandle?: RefObject<ComposerDraftHandle | null> | undefined;
  // --- équipes (it4) : fin ---
  // <c5:salle-propriete>
  /** GF5 : racine de la Salle OMO, ni puce « + Méthode » ni méthodes retenues (outilsDeConstruction). Absente : faux. */
  salle?: boolean;
  // </c5:salle-propriete>
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  // <c5:methodes-etat>
  // Méthodes retenues pour CE message (2 au plus, D-5-07) : elles ne vivent que le temps de l'envoi, comme le texte.
  const [methodes, setMethodes] = useState<ChosenMethod[]>([]);
  // </c5:methodes-etat>
  // <c5:salle-outils>
  const outils = outilsDeConstruction(salle);
  // </c5:salle-outils>
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchSeq = useRef(0);
  const selectId = useId();
  // --- équipes (it4) : début ---
  useImperativeHandle(
    draftHandle,
    () => ({
      get: () => teamDraftOf(text, attachments),
      clear: () => {
        setText("");
        setAttachments([]);
        setMenu(null);
      },
    }),
    [text, attachments],
  );
  // --- équipes (it4) : fin ---

  const commandName = /^\/([\w-]+)(?=\s|$)/.exec(text)?.[1] ?? null;
  // --- équipes (it4) : début ---
  /**
   * L44f : une ÉQUIPE tient la saisie. Le lanceur (emplacement figé, propriété `team`) n'est posé que par la page du chat, et
   * celle-ci ne met `disabled` QUE par le verrou d'équipe (`TeamRunCardsProps.onLockChange` → `teamLockProps` de ChatPage.tsx,
   * D-eq-16) : les deux ensemble disent « une équipe est choisie dans cette conversation ». Ce que vous écrirez ira alors aux
   * ÉTAPES de l'équipe, qui portent leurs propres méthodes (L42a) : la puce est éteinte et la phrase du §4.3 dit pourquoi. Rien
   * n'est retiré en silence — les méthodes déjà retenues restent visibles et retirables.
   * Ligne de la CONSTRUCTION dans un bloc de l'itération 4 : elle lit la propriété de l'emplacement, que web-equipes-slots.test.ts
   * (contrat de T4w) n'admet qu'entre ces balises. Clôture 5b (A20) : le bloc est désormais VOISIN de la section
   * c5:methodes-raccourci, jamais dedans ; l'exception est consignée pour la grande fusion (constats-5b.md).
   */
  const equipeChoisie = team !== undefined && disabled;
  // --- équipes (it4) : fin ---
  // <c5:methodes-raccourci>
  // Le raccourci se repère sur le texte RÉELLEMENT ENVOYÉ (`text.trim()`, plus bas), comme ChatPage.tsx le fait de son côté :
  // « ␣/resume » est un raccourci pour l'envoi, alors que la ligne d'origine ci-dessus, qui lit le texte brut, ne le voit pas.
  // Sans cette ligne, le bloc de méthode partait en ARGUMENTS du raccourci, sans qu'aucune phrase le dise (C §9.4).
  const raccourci = /^\/([\w-]+)(?=\s|$)/.exec(text.trimStart())?.[1] ?? null;
  // Message sans texte : le bloc seul ne serait une demande pour personne. Le refus est annoncé, comme celui du raccourci.
  const sansTexte = text.trim() === "";
  /** Phrase affichée sous la saisie quand les méthodes retenues ne partiront pas : l'équipe d'abord, puis les refus de L44e. */
  const raisonMethodes = equipeChoisie
    ? TEXTES_C5.partout.methodes.limites.equipe
    : raccourci !== null
      ? methodChipReason("raccourci")
      : sansTexte
        ? methodChipReason("sans-texte")
        : null;
  // </c5:methodes-raccourci>
  const onCommandChangeRef = useRef(onCommandChange);
  onCommandChangeRef.current = onCommandChange;
  useEffect(() => {
    onCommandChangeRef.current?.(commandName);
  }, [commandName]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    window.requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seed.text.length, seed.text.length);
    });
  }, [seed]);

  const searchFiles = (query: string) => {
    window.clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    searchTimer.current = window.setTimeout(() => {
      oc.findFiles(directory, query).then(
        (files) => {
          if (seq !== searchSeq.current) return;
          setMenu((m) =>
            m && m.kind === "file" && m.query === query ? { ...m, items: files.slice(0, 15).map((f) => ({ value: f, label: f })), index: 0 } : m,
          );
        },
        () => undefined,
      );
    }, 150);
  };

  const updateMenu = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const command = /^\/([\w-]*)$/.exec(before);
    if (command) {
      const query = (command[1] ?? "").toLowerCase();
      const items = commands
        .filter((c) => c.name.toLowerCase().includes(query))
        .slice(0, 12)
        .map((c) => ({ value: c.name, label: c.label, hint: c.hint }));
      setMenu(items.length > 0 ? { kind: "command", query, start: 0, items, index: 0 } : null);
      return;
    }
    const mention = /(^|\s)@([^\s@]*)$/.exec(before);
    if (mention) {
      const query = mention[2] ?? "";
      setMenu((m) => ({ kind: "file", query, start: caret - query.length - 1, items: m?.kind === "file" ? m.items : [], index: 0 }));
      searchFiles(query);
      return;
    }
    setMenu(null);
  };

  const pick = (item: MenuItem) => {
    if (!menu) return;
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    let next: string;
    let position: number;
    if (menu.kind === "command") {
      const rest = text.slice(caret).replace(/^\S*/, "");
      next = `/${item.value} ${rest.trimStart()}`;
      position = item.value.length + 2;
    } else {
      next = `${text.slice(0, menu.start)}@${item.value} ${text.slice(caret)}`;
      position = menu.start + item.value.length + 2;
      setAttachments((list) =>
        list.some((a) => a.kind === "file" && a.filename === item.value)
          ? list
          : [...list, { id: crypto.randomUUID(), kind: "file", filename: item.value, mime: "text/plain", url: fileUrl(directory, item.value) }],
      );
    }
    setText(next);
    setMenu(null);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(position, position);
    });
  };

  const addImages = async (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (imageModel && !imageModel.attachment) {
        toast.warning("Images non prises en charge", `${imageModel.name} n'accepte pas les images.`);
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.warning("Image trop lourde", "5 Mo maximum par image.");
        continue;
      }
      const url = await readAsDataUrl(file);
      setAttachments((list) =>
        list.filter((a) => a.kind === "image").length >= 4
          ? list
          : [...list, { id: crypto.randomUUID(), kind: "image", filename: file.name || "image.png", mime: file.type, url }],
      );
    }
  };

  const submit = () => {
    if (busy || disabled || sending) return;
    const trimmed = text.trim();
    const kept = attachments.filter((a) => a.kind === "image" || trimmed.includes(`@${a.filename}`));
    if (!trimmed && kept.length === 0) return;
    // <c5:methodes-instantane>
    // La ligne d'origine (`const snapshot = { text, attachments };`) garde aussi les méthodes retenues : elles reviennent avec
    // le texte quand rien n'est parti.
    const snapshot = { text, attachments, methodes };
    // </c5:methodes-instantane>
    // Rien n'a été envoyé : on remet le message, sauf si l'utilisateur a déjà recommencé à écrire.
    const restore = () => {
      setText((current) => (current ? current : snapshot.text));
      setAttachments((current) => (current.length > 0 ? current : snapshot.attachments));
      // <c5:methodes-restore>
      setMethodes((current) => (current.length > 0 ? current : snapshot.methodes));
      // </c5:methodes-restore>
    };
    // <c5:methodes-envoi>
    // Une méthode est un TEXTE (D-5-08) : son bloc est ajouté à la FIN du message, tel que l'aperçu le montre, et rien d'autre
    // ne change — aucun champ `system`, aucun appel d'IA en plus. Deux cas n'emportent aucun bloc : un message sans texte (le
    // bloc seul ne serait une demande pour personne) et un RACCOURCI (C §9.4) — dans les deux, la phrase du refus est affichée
    // sous les méthodes retenues AVANT l'envoi, et les méthodes retenues restent là après : rien n'est retiré en silence.
    const blocs = trimmed === "" || raccourci !== null ? "" : methodes.map((methode) => methode.texte).join("");
    const envoye = `${trimmed}${blocs}`;
    // </c5:methodes-envoi>
    setText("");
    setAttachments([]);
    setMenu(null);
    // <c5:methodes-vide>
    // Les méthodes ne sont vidées que si leurs blocs sont VRAIMENT partis : après l'envoi d'une image seule ou d'un raccourci,
    // elles restent retenues, avec leur phrase, et la personne peut écrire son message puis renvoyer.
    if (blocs !== "") setMethodes([]);
    // </c5:methodes-vide>
    // <c5:methodes-envoi-appel>
    // La ligne d'origine envoyait `text: trimmed` : c'est le même texte, avec les blocs de méthode ajoutés à la fin (D-5-08).
    const result = onSubmit({ text: envoye, attachments: kept });
    // </c5:methodes-envoi-appel>
    if (result instanceof Promise) {
      setSending(true);
      result
        .then(
          (ok) => {
            if (ok === false) restore();
          },
          () => restore(),
        )
        .finally(() => setSending(false));
    } else if (result === false) {
      restore();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && menu.items.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...menu, index: (menu.index + delta + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = menu.items[menu.index];
        if (item) pick(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const currentOption = agents.find((a) => a.name === agent);

  return (
    <div className="composer-wrap">
      {notice}
      <div
        className={`composer${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addImages(Array.from(e.dataTransfer.files));
        }}
      >
        {menu && menu.items.length > 0 ? (
          <div className="popover" role="listbox" aria-label={menu.kind === "command" ? "Raccourcis" : "Fichiers"}>
            {menu.items.map((item, i) => (
              <button
                key={item.value}
                type="button"
                role="option"
                className="popover-item"
                aria-selected={i === menu.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
              >
                <Icon name={menu.kind === "command" ? "terminal" : "file"} size={14} />
                <span className="ellipsis" style={{ flex: "none", maxWidth: "45%" }}>
                  {item.label}
                </span>
                {item.hint ? (
                  <span className="tiny muted ellipsis" style={{ marginLeft: "auto", minWidth: 0 }} title={item.hint}>
                    {item.hint}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="composer-assistant">
          <label className="small muted" htmlFor={selectId}>
            Assistant :
          </label>
          <select
            id={selectId}
            className="select sm"
            value={agent}
            title={currentOption?.help ?? undefined}
            disabled={disabled}
            onChange={(e) => onAgentChange(e.target.value)}
          >
            {currentOption ? null : <option value={agent}>{agentTitle}</option>}
            {agents.map((a) => (
              <option key={a.name} value={a.name} title={a.help ?? undefined}>
                {a.title}
              </option>
            ))}
          </select>
        </div>

        {attachments.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <span key={a.id} className="chip">
                {a.kind === "image" ? <img src={a.url} alt="" /> : <Icon name="file" size={12} />}
                <span className="ellipsis" style={{ maxWidth: 220 }}>
                  {a.filename}
                </span>
                <button
                  type="button"
                  className="btn ghost sm icon-only"
                  aria-label={`Retirer ${a.filename}`}
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {/* <c5:methodes-retenues> */}
        {/* Itération 5 (L44e) : méthodes retenues et aperçu MODIFIABLE du texte ajouté, sur leur propre ligne, comme les
            fichiers joints. Ce que l'aperçu montre est ce qui part. Les cas qui n'emportent aucun bloc — raccourci, message
            sans texte, et depuis L44f une équipe qui tient la saisie — affichent leur phrase ICI, avant l'envoi.
            Une équipe choisie sans aucune méthode retenue n'a pas de ligne de puces : la phrase se pose alors seule, pour que
            la puce éteinte ne reste jamais sans explication. */}
        {equipeChoisie && methodes.length === 0 ? (
          <div className="methodes-choisies">
            <p className="methodes-item-raison">{raisonMethodes}</p>
          </div>
        ) : null}
        {/* GF5 : aucune méthode retenue dans une racine de la salle. */}
        {outils.puceMethode ? <MethodChipList valeur={methodes} onChange={setMethodes} raison={raisonMethodes} /> : null}
        {/* </c5:methodes-retenues> */}

        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder ?? "Décrivez ce que vous voulez faire…"}
          aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            updateMenu(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (images.length > 0) {
              e.preventDefault();
              void addImages(images);
            }
          }}
          onBlur={() => window.setTimeout(() => setMenu(null), 150)}
        />

        <div className="composer-toolbar">
          <div className="spacer composer-ia">{ia}</div>
          <label className="btn ghost sm icon-only" title="Joindre une image">
            <Icon name="image" size={14} />
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addImages(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </label>
          {/* --- équipes (it4) : début --- */}
          {team}
          {/* --- équipes (it4) : fin --- */}
          {autonomy}
          {/* <c5:methodes-puce> */}
          {/* Itération 5 (L44e) : puce « + Méthode », avant « Envoyer » (C §9.4). Désactivée pour un raccourci, repéré sur le
              texte réellement envoyé (`raccourci`) : aucune méthode ne s'y ajoute.
              L44f : désactivée aussi quand une équipe tient la saisie (`equipeChoisie`) — les méthodes d'une équipe se règlent
              sur ses étapes. Les deux raisons sont écrites, même si `equipeChoisie` implique déjà `disabled` aujourd'hui. */}
          {/* GF5 : ni puce ni méthode dans une racine de la salle (outilsDeConstruction). */}
          {outils.puceMethode ? (
            <MethodChip agent={agent} estRaccourci={raccourci !== null} desactive={disabled || equipeChoisie} valeur={methodes} onChange={setMethodes} />
          ) : null}
          {/* </c5:methodes-puce> */}
          {/* 1.1 : « Arrêter » aussi quand l'arbre travaille (stopVisible) ; « Envoyer » tant que la racine ne travaille pas. */}
          {busy || stopVisible ? (
            <Button size="sm" variant="danger" icon="stop" onClick={onAbort}>
              Arrêter
            </Button>
          ) : null}
          {busy ? null : (
            <Button
              size="sm"
              variant="primary"
              icon="send"
              loading={sending}
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              onClick={submit}
            >
              Envoyer
            </Button>
          )}
        </div>
      </div>
      <p className="composer-hint">
        <kbd>Entrée</kbd> envoyer · <kbd>Maj</kbd>+<kbd>Entrée</kbd> nouvelle ligne · <kbd>@</kbd> joindre un fichier · <kbd>/</kbd> raccourci
      </p>
      <p className="composer-banner" role="note">
        <Icon name="shield" size={13} />
        <span>{MESSAGES.confidentialityBanner}</span>
      </p>
    </div>
  );
}
