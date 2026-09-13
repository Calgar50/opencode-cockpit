// Assistants prêts à l'emploi (catalogue livré) : cartes, aperçu et fenêtre d'installation (§9.3).
import { type CSSProperties, useCallback, useEffect, useId, useState } from "react";
import { NAME_RE, RIGHTS_INFO, TIER_LABELS, USE_CASE_INFO } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, Field, Modal } from "../../components/ui.tsx";
import { ApiError, api } from "../../lib/api.ts";
import { openChatWithAssistant } from "../../lib/router.ts";
import type { AssistantView, CatalogueItem } from "../../lib/types.ts";
import { assistantErrorText, isRejected, technicalDetail } from "./errors.ts";
import { IdentityCard, identityOfCatalogue, identityOfView } from "./IdentityCard.tsx";
import { unavailableTierText } from "./TierCards.tsx";

export function CatalogueGrid({ items, onChanged }: { items: readonly CatalogueItem[]; onChanged: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const open = items.find((i) => i.id === openId) ?? null;
  return (
    <>
      <div className="ast-grid">
        {items.map((item) => (
          <CatalogueCard key={item.id} item={item} onOpen={() => setOpenId(item.id)} />
        ))}
      </div>
      <InstallAssistantDialog item={open} onClose={close} onInstalled={onChanged} />
    </>
  );
}

function CatalogueCard({ item, onOpen }: { item: CatalogueItem; onOpen: () => void }) {
  const info = USE_CASE_INFO[item.useCase];
  return (
    <article className="ast-card" style={{ "--ast-color": info.color } as CSSProperties}>
      <div className="ast-card-head">
        <span className="ast-icon" aria-hidden>
          <Icon name={item.icon} size={16} />
        </span>
        <h3 className="spacer">{item.title}</h3>
        {item.installed ? (
          <Badge tone="good">
            <Icon name="check" size={12} />
            Installé
          </Badge>
        ) : null}
      </div>
      <p className="small secondary ast-desc">{item.description}</p>
      <p className="small">
        {RIGHTS_INFO[item.rights].label} · Niveau {TIER_LABELS[item.tier]}
        {item.estimate ? ` · ${item.estimate.text}` : ""}
        {item.fiches.length > 0 ? ` · Fiches : ${item.fiches.length}` : ""}
      </p>
      <div className="row wrap" style={{ gap: 6 }}>
        <Badge tone="warning">{item.review}</Badge>
        {item.tierStatus === "indisponible" ? <Badge tone="critical">IA indisponible</Badge> : null}
      </div>
      <div className="ast-card-actions">
        {item.installed && item.installedName ? (
          <Button size="sm" variant="primary" icon="chat" onClick={() => item.installedName && openChatWithAssistant(item.installedName)}>
            Utiliser dans le chat
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon="download" onClick={onOpen}>
            Installer
          </Button>
        )}
        <Button size="sm" icon="eye" onClick={onOpen}>
          Aperçu
        </Button>
      </div>
    </article>
  );
}

/**
 * Fenêtre « Installer « {titre} » » : carte d'identité, fiches installées avec l'assistant, choix d'un autre nom si le
 * nom est pris. Réutilisable par l'accueil du chat (`onInstalled` reçoit l'assistant installé).
 */
export function InstallAssistantDialog({
  item,
  onClose,
  onInstalled,
}: {
  item: CatalogueItem | null;
  onClose: () => void;
  onInstalled?: (view: AssistantView) => void;
}) {
  const toast = useToast();
  const nameId = useId();
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState<AssistantView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nameTaken, setNameTaken] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    setInstalled(null);
    setError(null);
    setNameTaken(false);
    setName(item ? `${item.id}-2` : "");
    // Réinitialisation seulement quand on ouvre une autre entrée (les rechargements gardent la saisie).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const nameValid = NAME_RE.test(name) && name.length <= 64;
  const alreadyInstalled = Boolean(item?.installed && item.installedName);
  const usableName = installed?.name ?? (alreadyInstalled ? item?.installedName : null) ?? null;

  const install = async () => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.installCatalogueAssistant(item.id, nameTaken ? name : undefined);
      setInstalled(view);
      toast.success("Assistant installé", "Il apparaît maintenant dans le chat.", {
        label: "Essayer",
        onClick: () => {
          onClose();
          openChatWithAssistant(view.name);
        },
      });
      onInstalled?.(view);
    } catch (err) {
      if (err instanceof ApiError && err.code === "name-taken") setNameTaken(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const title = item ? (alreadyInstalled || installed ? `« ${item.title} »` : `Installer « ${item.title} »`) : "";
  const footer = !item ? null : usableName ? (
    <>
      <Button onClick={onClose}>Fermer</Button>
      <Button
        variant="primary"
        icon="chat"
        onClick={() => {
          onClose();
          openChatWithAssistant(usableName);
        }}
      >
        {installed ? "Essayer" : "Utiliser dans le chat"}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>Annuler</Button>
      <Button
        variant="primary"
        icon="download"
        loading={busy}
        disabled={item.tierStatus === "indisponible" || (nameTaken && !nameValid)}
        onClick={() => void install()}
      >
        Installer
      </Button>
    </>
  );

  return (
    <Modal open={item !== null} wide title={title} onClose={onClose} footer={footer}>
      {item ? (
        <div className="stack">
          {installed ? (
            <div className="callout good" role="status">
              <Icon name="check" size={18} />
              <span>
                <strong>Assistant installé.</strong> Il apparaît maintenant dans le chat.
              </span>
            </div>
          ) : null}
          {!installed && !alreadyInstalled && item.newFiches.length > 0 ? (
            <div className="callout warning">
              <Icon name="book" size={18} />
              <div className="stack tight">
                {item.newFiches.map((fiche) => (
                  <span key={fiche}>Installe aussi la fiche « {fiche} » : relisez-la avec votre équipe.</span>
                ))}
              </div>
            </div>
          ) : null}
          {!installed && item.tierStatus === "indisponible" ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <span>{unavailableTierText(item.tier)}</span>
            </div>
          ) : null}
          <IdentityCard data={installed ? identityOfView(installed, item.review) : identityOfCatalogue(item)} />
          {nameTaken && !installed ? (
            <Field
              label="Nom technique"
              htmlFor={nameId}
              hint="Minuscules, chiffres et tirets. Nom technique du fichier."
              error={nameValid ? null : "Utilisez uniquement des minuscules, des chiffres et des tirets."}
            >
              <input id={nameId} className="input mono" value={name} maxLength={64} onChange={(e) => setName(e.target.value.trim())} style={{ maxWidth: 360 }} />
            </Field>
          ) : null}
          {error ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <div className="stack tight" style={{ minWidth: 0 }}>
                <span>{assistantErrorText(error)}</span>
                {isRejected(error) && technicalDetail(error) ? (
                  <details>
                    <summary>Détail technique</summary>
                    <pre className="wiz-detail">{technicalDetail(error)}</pre>
                  </details>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
