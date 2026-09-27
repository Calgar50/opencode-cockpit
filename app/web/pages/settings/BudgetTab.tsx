// Budget mensuel, alertes, garde-fou, plafonds du travail automatique (1.1, L12c) et synchronisation optionnelle du solde réel
// GitHub. Les plafonds d'autonomie (budget.autonomie.*) et de travail délégué (budget.delegation.*) se règlent dans LES DEUX
// modes (SIMPLE_SETTINGS_PATHS, spécification §3.6) : leurs bornes sont celles du serveur (settings.ts), qui refuse le reste.
import { useEffect, useId, useState } from "react";
import { libelleChoix } from "../../../server/shared/autonomy-choice-texts.ts";
import { TEXTES as TEXTES_AUTONOMIE } from "../../../server/shared/autonomy-texts.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, Card, Field, Meter, Spinner, ToggleRow, useAsync } from "../../components/ui.tsx";
import { api, errorText } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";
import { formatCredits, formatDateTime, formatPercent, formatUsd, relativeTime } from "../../lib/format.ts";
import type { AutonomieSettings, DelegationSettings } from "../../../server/shared/api-types.ts";
import type { QuotaSnapshot } from "../../lib/types.ts";
import { NumberInput, TokenListEditor } from "../studio/widgets.tsx";
import { fmtNumber, SectionFooter, useDraft, useSettingsSave } from "./common.tsx";
// --- équipes (it4) : début ---
import { TeamsBudgetSettings } from "./TeamsBudgetSettings.tsx";
// --- équipes (it4) : fin ---

function QuotaSection({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const { boot, advanced } = useApp();
  const toast = useToast();
  const intervalId = useId();
  const { draft, setDraft, dirty, reset } = useDraft(boot.settings.quotaSync);
  const { save, resetSection, saving, issues } = useSettingsSave();
  const quota = useAsync(() => api.quota(), []);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  useEvents((event) => {
    const updated = cockpitEvent(event, "quota.updated");
    if (updated) quota.setData((q) => (q ? { ...q, latest: updated.data as QuotaSnapshot, lastError: null } : q));
  });

  const syncNow = async () => {
    setSyncing(true);
    try {
      const snapshot = await api.syncQuota();
      quota.setData((q) => ({ enabled: q?.enabled ?? draft.enabled, latest: snapshot, lastError: null }));
      toast.success("Solde synchronisé");
    } catch (err) {
      toast.error("Synchronisation impossible", err);
      quota.reload();
    } finally {
      setSyncing(false);
    }
  };

  const latest = quota.data?.latest ?? null;
  const used = latest?.percentRemaining !== null && latest?.percentRemaining !== undefined ? 100 - latest.percentRemaining : null;

  return (
    <Card title="Solde réel GitHub (optionnel)" subtitle="Compare l'estimation du cockpit au solde affiché par GitHub.">
      <div className="settings-form">
        <div className="callout warning">
          <Icon name="alert" size={18} />
          <span>
            Cette option interroge un point d'accès GitHub <strong>non documenté</strong> (<code>copilot_internal/user</code>) avec le jeton
            Copilot, uniquement vers api.github.com (ou votre GitHub Enterprise). Il peut changer ou disparaître sans préavis.
          </span>
        </div>
        {advanced ? (
          <>
            <div>
              <ToggleRow
                title="Synchroniser automatiquement"
                description="Relevé périodique du solde depuis le serveur du cockpit."
                checked={draft.enabled}
                onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
              />
            </div>
            <Field label="Intervalle" htmlFor={intervalId} hint="Entre 5 et 1 440 minutes.">
              <div className="input-suffix">
                <NumberInput
                  id={intervalId}
                  value={draft.intervalMinutes}
                  min={5}
                  max={1440}
                  step={1}
                  disabled={!draft.enabled}
                  onChange={(n) => n !== undefined && setDraft((d) => ({ ...d, intervalMinutes: Math.round(n) }))}
                />
                <span className="small muted">minutes</span>
              </div>
            </Field>
          </>
        ) : (
          <p className="small secondary">
            Synchronisation automatique : {draft.enabled ? `activée (toutes les ${fmtNumber(draft.intervalMinutes, 0)} minutes)` : "désactivée"}. Réglable en mode Avancé (Paramètres › Affichage).
          </p>
        )}

        <div className="stack tight">
          <div className="row between wrap">
            <strong className="small">Dernier relevé</strong>
            <Button size="sm" icon="refresh" loading={syncing} onClick={() => void syncNow()} disabled={!boot.copilotConnected}>
              Synchroniser maintenant
            </Button>
          </div>
          {quota.loading && !quota.data ? (
            <Spinner />
          ) : quota.error ? (
            <div className="callout critical">{errorText(quota.error)}</div>
          ) : latest ? (
            <div className="stack tight">
              <div className="quota-grid">
                <div className="stat-tile">
                  <span className="label">Forfait</span>
                  <span className="value" style={{ fontSize: 16 }}>
                    {latest.plan ?? "—"}
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="label">Allocation</span>
                  <span className="value tabular" style={{ fontSize: 16 }}>
                    {latest.unlimited ? "Illimitée" : latest.entitlement !== null ? fmtNumber(latest.entitlement, 2) : "—"}
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="label">Restant</span>
                  <span className="value tabular" style={{ fontSize: 16 }}>
                    {latest.remaining !== null ? fmtNumber(latest.remaining, 2) : "—"}
                  </span>
                  {latest.percentRemaining !== null ? <span className="sub">{formatPercent(latest.percentRemaining)} restant</span> : null}
                </div>
                {latest.overageCount ? (
                  <div className="stat-tile">
                    <span className="label">Dépassement</span>
                    <span className="value tabular" style={{ fontSize: 16 }}>
                      {fmtNumber(latest.overageCount, 2)}
                    </span>
                  </div>
                ) : null}
              </div>
              {used !== null ? <Meter percent={used} label="Part de l'allocation GitHub consommée" /> : null}
              <span className="tiny muted">
                Relevé du {formatDateTime(latest.takenAt)} ({relativeTime(latest.takenAt)})
              </span>
            </div>
          ) : (
            <p className="small muted">Aucun relevé pour l'instant.</p>
          )}
          {quota.data?.lastError ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <span>Dernière erreur : {quota.data.lastError}</span>
            </div>
          ) : null}
          {!boot.copilotConnected ? <p className="small muted">GitHub Copilot doit être connecté pour relever le solde.</p> : null}
        </div>

        {advanced ? (
          <SectionFooter
            dirty={dirty}
            saving={saving}
            issues={issues}
            onCancel={reset}
            onSave={async () => {
              if (await save({ quotaSync: draft }, "Synchronisation du solde enregistrée")) quota.reload();
            }}
            onReset={async () => {
              await resetSection("quotaSync", "Synchronisation du solde réinitialisée");
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** Bornes du serveur (settings.ts) : l'interface ne propose jamais une valeur que le schéma refuserait. */
const BORNES = {
  delegationUsd: { min: 0, max: 100, step: 0.5 },
  delegationNombre: { min: 0, max: 50 },
  plafondUsd: { min: 0.01, max: 50, step: 0.5 },
  actionsMax: { min: 1, max: 500 },
  delegationsMax: { min: 0, max: 50 },
  dureeMinutes: { min: 1, max: 240 },
  fichiersMax: { min: 1, max: 500 },
  controlesIaMax: { min: 0, max: 200 },
};

const LIBELLES = TEXTES_AUTONOMIE.partout.plafonds.libelles;

/**
 * Plafonds du travail automatique (spécification §3.6, §4.8, décision n° 9), réglables dans les deux modes : travail délégué
 * (budget.delegation) et « Autonome avec contrôle » (budget.autonomie). Chaque plafond est borné comme le serveur le borne ;
 * le plafond d'arrêt par défaut ne peut pas dépasser le plafond maximal, que le serveur refuse aussi.
 */
function AutomaticCaps({
  delegation,
  autonomie,
  onDelegation,
  onAutonomie,
}: {
  delegation: DelegationSettings;
  autonomie: AutonomieSettings;
  onDelegation: (patch: Partial<DelegationSettings>) => void;
  onAutonomie: (patch: Partial<AutonomieSettings>) => void;
}) {
  const ids = {
    delegationUsd: useId(),
    delegationNombre: useId(),
    plafondUsd: useId(),
    plafondMaxUsd: useId(),
    actionsMax: useId(),
    delegationsMax: useId(),
    dureeMinutes: useId(),
    fichiersMax: useId(),
    controlesIaMax: useId(),
  };
  const entier = (patch: (n: number) => void) => (n: number | undefined) => n !== undefined && patch(Math.round(n));
  const plafondTropHaut = autonomie.plafondUsd > autonomie.plafondMaxUsd;

  return (
    <>
      <h3 className="settings-subtitle">Travail délégué par l'IA</h3>
      <div className="grid-2">
        <Field label="Coût par demande" htmlFor={ids.delegationUsd} hint={`Soit ${formatCredits(delegation.maxUsdPerRequest)}.`}>
          <div className="input-suffix">
            <NumberInput
              id={ids.delegationUsd}
              value={delegation.maxUsdPerRequest}
              {...BORNES.delegationUsd}
              onChange={(n) => n !== undefined && onDelegation({ maxUsdPerRequest: n })}
            />
            <span className="small muted">$ par demande</span>
          </div>
        </Field>
        <Field label="Nombre par demande" htmlFor={ids.delegationNombre} hint="Au-delà, le travail délégué attend votre accord.">
          <NumberInput
            id={ids.delegationNombre}
            value={delegation.maxPerRequest}
            {...BORNES.delegationNombre}
            step={1}
            onChange={entier((n) => onDelegation({ maxPerRequest: n }))}
          />
        </Field>
      </div>

      <h3 className="settings-subtitle">{libelleChoix("autonome")}</h3>
      <div className="grid-2">
        <Field
          label={LIBELLES.plafondUsd}
          htmlFor={ids.plafondUsd}
          hint={`Proposé à chaque activation, modifiable dans la confirmation. Soit ${formatCredits(autonomie.plafondUsd)}.`}
          {...(plafondTropHaut ? { error: "Le plafond proposé dépasse le plafond maximal." } : {})}
        >
          <div className="input-suffix">
            <NumberInput
              id={ids.plafondUsd}
              value={autonomie.plafondUsd}
              {...BORNES.plafondUsd}
              onChange={(n) => n !== undefined && onAutonomie({ plafondUsd: n })}
            />
            <span className="small muted">$ par demande</span>
          </div>
        </Field>
        <Field label="Plafond maximal" htmlFor={ids.plafondMaxUsd} hint="Valeur la plus haute que la confirmation accepte.">
          <div className="input-suffix">
            <NumberInput
              id={ids.plafondMaxUsd}
              value={autonomie.plafondMaxUsd}
              {...BORNES.plafondUsd}
              onChange={(n) => n !== undefined && onAutonomie({ plafondMaxUsd: n })}
            />
            <span className="small muted">$ par demande</span>
          </div>
        </Field>
        <Field label={LIBELLES.actionsMax} htmlFor={ids.actionsMax} hint="Au-delà, retour à « Demander à chaque fois ».">
          <NumberInput
            id={ids.actionsMax}
            value={autonomie.actionsMax}
            {...BORNES.actionsMax}
            step={1}
            onChange={entier((n) => onAutonomie({ actionsMax: n }))}
          />
        </Field>
        <Field label={LIBELLES.delegationsMax} htmlFor={ids.delegationsMax} hint="Travail confié à un autre assistant, par demande.">
          <NumberInput
            id={ids.delegationsMax}
            value={autonomie.delegationsMax}
            {...BORNES.delegationsMax}
            step={1}
            onChange={entier((n) => onAutonomie({ delegationsMax: n }))}
          />
        </Field>
        <Field label={LIBELLES.dureeMinutes} htmlFor={ids.dureeMinutes} hint="Durée maximale d'une demande automatique.">
          <NumberInput
            id={ids.dureeMinutes}
            value={autonomie.dureeMinutes}
            {...BORNES.dureeMinutes}
            step={1}
            onChange={entier((n) => onAutonomie({ dureeMinutes: n }))}
          />
        </Field>
        <Field label={LIBELLES.fichiersMax} htmlFor={ids.fichiersMax} hint="Fichiers différents modifiés sans vous demander.">
          <NumberInput
            id={ids.fichiersMax}
            value={autonomie.fichiersMax}
            {...BORNES.fichiersMax}
            step={1}
            onChange={entier((n) => onAutonomie({ fichiersMax: n }))}
          />
        </Field>
        <Field label={LIBELLES.controlesIaMax} htmlFor={ids.controlesIaMax} hint="Chaque contrôle par IA est facturé.">
          <NumberInput
            id={ids.controlesIaMax}
            value={autonomie.controlesIaMax}
            {...BORNES.controlesIaMax}
            step={1}
            disabled={!autonomie.controleIa}
            onChange={entier((n) => onAutonomie({ controlesIaMax: n }))}
          />
        </Field>
      </div>
      <div>
        <ToggleRow
          title="Faire juger les commandes inconnues par l'IA de contrôle"
          description="Coupée, les commandes que le cockpit ne connaît pas attendent votre accord au lieu d'être jugées."
          checked={autonomie.controleIa}
          onChange={(controleIa) => onAutonomie({ controleIa })}
        />
      </div>
    </>
  );
}

export function BudgetTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { boot, advanced } = useApp();
  const ids = { monthly: useId(), from: useId(), price: useId() };
  const { draft, setDraft, dirty, reset } = useDraft(boot.settings.budget);
  const { save, resetSection, saving, issues } = useSettingsSave();
  const [quotaDirty, setQuotaDirty] = useState(false);
  // --- équipes (it4) : début ---
  const [teamsDirty, setTeamsDirty] = useState(false);
  // --- équipes (it4) : fin ---

  // --- équipes (it4) : début ---
  // Ligne REMPLACÉE (elle ne s'ajoute pas) : l'originale de l'itération 1 est
  // `useEffect(() => onDirtyChange(dirty || quotaDirty), [dirty, quotaDirty, onDirtyChange]);`
  // et le bloc des équipes s'ajoute aux sections qui salissent l'onglet.
  useEffect(() => onDirtyChange(dirty || quotaDirty || teamsDirty), [dirty, quotaDirty, teamsDirty, onDirtyChange]);
  // --- équipes (it4) : fin ---
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const expensive = boot.models
    .filter((m) => (m.price?.rates.output ?? 0) > draft.guard.maxOutputPricePerM)
    .sort((a, b) => (b.price?.rates.output ?? 0) - (a.price?.rates.output ?? 0));

  const setGuard = (patch: Partial<typeof draft.guard>) => setDraft((d) => ({ ...d, guard: { ...d.guard, ...patch } }));

  return (
    <div className="stack loose">
      <div className="callout accent">
        <Icon name="coins" size={18} />
        <span>
          Depuis juin 2026, GitHub Copilot facture chaque requête en <strong>crédits IA</strong> calculés sur les tokens consommés (1 crédit =
          0,01 $). Le compteur repart à zéro le <strong>1er de chaque mois à 00:00 UTC</strong>. Le budget ci-dessous est suivi par le cockpit :
          il ne bloque rien côté GitHub.
        </span>
      </div>

      <Card title="Budget mensuel" subtitle={`Ce mois-ci : ${formatUsd(boot.usage.spentUsd)} dépensés (${formatPercent(boot.usage.percent)}).`}>
        <div className="settings-form">
          <Field label="Montant mensuel" htmlFor={ids.monthly} hint={`Soit ${formatCredits(draft.monthlyUsd)}.`}>
            <div className="input-suffix">
              <NumberInput
                id={ids.monthly}
                value={draft.monthlyUsd}
                min={0}
                max={100_000}
                step={1}
                onChange={(n) => n !== undefined && setDraft((d) => ({ ...d, monthlyUsd: n }))}
              />
              <span className="small muted">$ par mois</span>
            </div>
          </Field>

          <div className="field">
            <span className="field-label">Alertes</span>
            <TokenListEditor
              label="Seuils d'alerte"
              values={draft.alertThresholds.map(String)}
              placeholder="Seuil en % (ex. 80)"
              addLabel="Ajouter un seuil"
              renderToken={(v) => <span className="threshold-chip">{v} %</span>}
              validate={(v) => {
                const n = Number(v.replace("%", "").trim());
                if (!Number.isInteger(n) || n < 1 || n > 200) return "Nombre entier entre 1 et 200.";
                if (draft.alertThresholds.includes(n)) return "Seuil déjà présent.";
                if (draft.alertThresholds.length >= 10) return "10 seuils maximum.";
                return null;
              }}
              onChange={(values) =>
                setDraft((d) => ({
                  ...d,
                  alertThresholds: [...new Set(values.map((v) => Number(v.replace("%", "").trim())))].filter(Number.isFinite).sort((a, b) => a - b),
                }))
              }
            />
            <span className="field-hint">Une notification s'affiche quand la dépense du mois franchit chacun de ces pourcentages.</span>
          </div>

          <h3 className="settings-subtitle">Garde-fou</h3>
          {advanced ? (
            <>
              <div>
                <ToggleRow
                  title="Confirmer avant d'utiliser un modèle cher"
                  description="Quand le budget se remplit, l'envoi vers un modèle cher demande une confirmation dans le chat."
                  checked={draft.guard.enabled}
                  onChange={(enabled) => setGuard({ enabled })}
                />
              </div>
              <div className="grid-2">
                <Field label="À partir de" htmlFor={ids.from} hint="Pourcentage du budget consommé à partir duquel le garde-fou s'active.">
                  <div className="input-suffix">
                    <NumberInput
                      id={ids.from}
                      value={draft.guard.fromPercent}
                      min={0}
                      max={200}
                      step={1}
                      disabled={!draft.guard.enabled}
                      onChange={(n) => n !== undefined && setGuard({ fromPercent: n })}
                    />
                    <span className="small muted">%</span>
                  </div>
                </Field>
                <Field
                  label="Modèle « cher » au-delà de"
                  htmlFor={ids.price}
                  hint="Prix de sortie en dollars par million de tokens générés au-delà duquel un modèle est considéré comme cher."
                >
                  <div className="input-suffix">
                    <NumberInput
                      id={ids.price}
                      value={draft.guard.maxOutputPricePerM}
                      min={0}
                      max={1000}
                      step={0.5}
                      disabled={!draft.guard.enabled}
                      onChange={(n) => n !== undefined && setGuard({ maxOutputPricePerM: n })}
                    />
                    <span className="small muted">$ / M tokens</span>
                  </div>
                </Field>
              </div>
              <p className="small muted">
                {expensive.length === 0
                  ? "Aucun modèle du catalogue ne dépasse ce seuil."
                  : `${expensive.length} modèle${expensive.length > 1 ? "s" : ""} au-delà de ce seuil : `}
                {expensive.slice(0, 8).map((m) => (
                  <Badge key={m.key} tone="warning" title={`${fmtNumber(m.price?.rates.output ?? 0, 2)} $/M en sortie`}>
                    {m.name}
                  </Badge>
                ))}
                {expensive.length > 8 ? ` +${expensive.length - 8}` : ""}
              </p>
              <div>
                <ToggleRow
                  title="Confirmation obligatoire à 100 %"
                  description="Budget atteint : tout envoi vers un modèle payant demande une confirmation."
                  checked={draft.guard.blockAtLimit}
                  onChange={(blockAtLimit) => setGuard({ blockAtLimit })}
                />
              </div>
            </>
          ) : (
            <div className="callout">
              <Icon name="lock" size={16} />
              <span className="small">
                {draft.guard.enabled
                  ? `Confirmation demandée à partir de ${fmtNumber(draft.guard.fromPercent, 0)} % du budget consommé pour une IA à plus de ${fmtNumber(draft.guard.maxOutputPricePerM, 2)} $ par million de jetons produits.`
                  : "Garde-fou désactivé."}
                {draft.guard.enabled && draft.guard.blockAtLimit ? " Budget atteint : toute demande payante demande une confirmation." : ""} Réglable en mode Avancé (Paramètres › Affichage).
              </span>
            </div>
          )}

          <AutomaticCaps
            delegation={draft.delegation}
            autonomie={draft.autonomie}
            onDelegation={(patch) => setDraft((d) => ({ ...d, delegation: { ...d.delegation, ...patch } }))}
            onAutonomie={(patch) => setDraft((d) => ({ ...d, autonomie: { ...d.autonomie, ...patch } }))}
          />

          <SectionFooter
            dirty={dirty}
            saving={saving}
            issues={issues}
            onCancel={reset}
            // Tout le budget SAUF `omo` : le dernier montant de la Salle OMO n'est écrit que par une activation confirmée (D-2b-11).
            // Renvoyé depuis un brouillon ouvert avant cette activation, il serait périmé et le serveur refuserait tout (403
            // « reglage-fixe ») ; absent du corps, il reste tel quel (réglages fusionnés, pas remplacés).
            onSave={() => void save({ budget: Object.fromEntries(Object.entries(draft).filter(([cle]) => cle !== "omo")) }, "Budget enregistré", { refreshBoot: true })}
            onReset={async () => {
              await resetSection("budget", "Budget réinitialisé", true);
            }}
          />
        </div>
      </Card>

      {/* --- équipes (it4) : début --- */}
      {advanced ? <TeamsBudgetSettings onDirty={setTeamsDirty} /> : null}
      {/* --- équipes (it4) : fin --- */}
      <QuotaSection onDirty={setQuotaDirty} />
    </div>
  );
}
