// Archives : liste filtrable (recherche plein texte, période, projet, épinglées, catégories) avec pagination.
import {
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, CategoryChip, EmptyState, Segmented, Spinner, useAsync } from "../../components/ui.tsx";
import { type ArchiveQuery, api, errorText } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";
import { formatDateTime, formatInt, formatUsd, plural, relativeTime } from "../../lib/format.ts";
import { routeHref } from "../../lib/router.ts";
import type { ArchiveList, Category, Conversation } from "../../lib/types.ts";
import {
  type ArchiveFilters,
  ClassificationBadge,
  DEFAULT_FILTERS,
  DeletedBadge,
  hasActiveFilters,
  PERIOD_DAYS,
  type Period,
  Snippet,
  useDebouncedValue,
} from "./shared.tsx";

const PAGE_SIZE = 50;
/** Taille de page maximale acceptée par le serveur. */
const MAX_PAGE_SIZE = 200;
/** Nombre maximal de résultats renvoyés par une recherche plein texte. */
const SEARCH_CAP = 500;
const SEARCH_DELAY_MS = 300;
const LIVE_REFRESH_MS = 800;
const DAY_MS = 86_400_000;

const PERIOD_OPTIONS: Array<{ value: Period; label: string; title: string }> = [
  { value: "7", label: "7 j", title: "Actives ces 7 derniers jours" },
  { value: "30", label: "30 j", title: "Actives ces 30 derniers jours" },
  { value: "90", label: "90 j", title: "Actives ces 90 derniers jours" },
  { value: "all", label: "Tout", title: "Toutes les conversations" },
];

/** Recharge les `count` premières conversations par pages successives (conserve ce qui était affiché). */
async function fetchWindow(query: ArchiveQuery, count: number): Promise<ArchiveList> {
  const items: Conversation[] = [];
  let total = 0;
  while (items.length < count) {
    const limit = Math.min(MAX_PAGE_SIZE, count - items.length);
    const page = await api.archiveList({ ...query, limit, offset: items.length });
    total = page.total;
    items.push(...page.items);
    if (page.items.length < limit || items.length >= total) break;
  }
  return { items, total };
}

function mergeUnique(current: Conversation[], next: Conversation[]): Conversation[] {
  const seen = new Set(current.map((c) => c.sessionId));
  return [...current, ...next.filter((c) => !seen.has(c.sessionId))];
}

function describeCount(list: ArchiveList | null, search: string): string {
  if (!list) return "Chargement…";
  if (!search) return plural(list.total, "conversation", "conversations");
  const found = list.total >= SEARCH_CAP ? `${formatInt(SEARCH_CAP)} premiers résultats` : plural(list.total, "résultat", "résultats");
  return `${found} pour « ${search} »`;
}

export function ArchiveListView({
  filters,
  setFilters,
  refreshToken,
}: {
  filters: ArchiveFilters;
  setFilters: Dispatch<SetStateAction<ArchiveFilters>>;
  /** Incrémenté par la page quand la liste doit être relue (suppression depuis la fiche). */
  refreshToken: number;
}) {
  const { categories, categoryById } = useApp();
  const toast = useToast();
  const stats = useAsync(() => api.archiveStats(), []);
  const search = useDebouncedValue(filters.q.trim(), SEARCH_DELAY_MS);
  const { period, project, pinned, category } = filters;

  const [list, setList] = useState<ArchiveList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rescanning, setRescanning] = useState(false);
  const sequence = useRef(0);
  const loadedCount = useRef(0);
  loadedCount.current = list?.items.length ?? 0;

  const buildQuery = useCallback((): ArchiveQuery => {
    const days = PERIOD_DAYS[period];
    return {
      q: search || undefined,
      category: category ?? undefined,
      project: project || undefined,
      pinned: pinned || undefined,
      from: days === null ? undefined : Date.now() - days * DAY_MS,
    };
  }, [search, category, project, pinned, period]);

  /** Charge (ou recharge) les `count` premiers résultats ; `quiet` évite d'estomper la liste. */
  const load = useCallback(
    async (count: number, quiet: boolean) => {
      const id = ++sequence.current;
      if (!quiet) setLoading(true);
      try {
        const result = await fetchWindow(buildQuery(), Math.max(PAGE_SIZE, count));
        if (id !== sequence.current) return;
        setList(result);
        setError(null);
      } catch (err) {
        if (id !== sequence.current) return;
        setError(err);
      } finally {
        if (id === sequence.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [buildQuery],
  );

  // Nouveaux critères : on repart de la première page.
  useEffect(() => {
    void load(PAGE_SIZE, false);
  }, [load]);

  const refreshNow = useRef<() => void>(() => undefined);
  refreshNow.current = () => {
    void load(loadedCount.current, true);
    stats.reload();
  };

  // « usage.updated » signale aussi la fin d'une réanalyse de l'historique (qui n'émet pas d'événement de conversation).
  const liveTimer = useRef<number | undefined>(undefined);
  useEvents((event) => {
    if (!cockpitEvent(event, "conversation.classified", "conversation.updated", "stream.reconnected", "usage.updated")) return;
    window.clearTimeout(liveTimer.current);
    liveTimer.current = window.setTimeout(() => refreshNow.current(), LIVE_REFRESH_MS);
  });
  useEffect(() => () => window.clearTimeout(liveTimer.current), []);

  const lastToken = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === lastToken.current) return;
    lastToken.current = refreshToken;
    refreshNow.current();
  }, [refreshToken]);

  const loadMore = async () => {
    if (!list) return;
    const id = ++sequence.current;
    setLoadingMore(true);
    try {
      const page = await api.archiveList({ ...buildQuery(), limit: PAGE_SIZE, offset: list.items.length });
      if (id !== sequence.current) return;
      setList((previous) => ({ items: mergeUnique(previous?.items ?? [], page.items), total: page.total }));
    } catch (err) {
      if (id !== sequence.current) return;
      toast.error("Chargement impossible", err);
    } finally {
      if (id === sequence.current) {
        setLoadingMore(false);
        setLoading(false);
      }
    }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await api.archiveRescan();
      toast.success(
        "Réanalyse lancée",
        "L'historique d'opencode est relu en arrière-plan ; les archives se mettent à jour au fil de l'eau.",
      );
    } catch (err) {
      toast.error("Réanalyse impossible", err);
    } finally {
      setRescanning(false);
    }
  };

  const update = (patch: Partial<ArchiveFilters>) => setFilters((previous) => ({ ...previous, ...patch }));
  const resetFilters = () => setFilters(DEFAULT_FILTERS);

  const counts = useMemo(
    () => new Map<string, number>((stats.data?.categories ?? []).map((s): [string, number] => [s.category, s.conversations])),
    [stats.data],
  );
  const totalArchived = stats.data ? stats.data.categories.reduce((sum, s) => sum + s.conversations, 0) : null;
  const orphanCategories = (stats.data?.categories ?? []).filter((s) => s.conversations > 0 && !categoryById(s.category));
  const projects = useMemo(() => {
    const known = stats.data?.projects ?? [];
    return project && !known.includes(project) ? [...known, project] : known;
  }, [stats.data, project]);
  const countPlaceholder = stats.loading ? "…" : "—";
  const active = hasActiveFilters(filters);

  return (
    <div className="archives">
      <header className="page-header">
        <div className="stack tight spacer archives-heading">
          <h1>Archives</h1>
          <p>
            Chaque conversation inactive est archivée puis classée automatiquement ; une copie Markdown est rangée par catégorie dans le
            dossier des archives.
          </p>
        </div>
        <Button
          icon="refresh"
          loading={rescanning}
          title="Relit tout l'historique d'opencode pour compléter les archives"
          onClick={() => void rescan()}
        >
          Réanalyser l'historique
        </Button>
      </header>

      <div className="archives-toolbar" role="search">
        <div className="search-input archives-search">
          <Icon name="search" />
          <input
            type="search"
            className="input"
            value={filters.q}
            maxLength={200}
            placeholder="Rechercher dans les titres, résumés, tags et transcriptions…"
            aria-label="Rechercher dans les archives"
            onChange={(e) => update({ q: e.target.value })}
          />
        </div>
        <Segmented label="Période d'activité" value={period} options={PERIOD_OPTIONS} onChange={(value) => update({ period: value })} />
        <select className="select archives-select" aria-label="Projet" value={project} onChange={(e) => update({ project: e.target.value })}>
          <option value="">Tous les projets</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="button" className="chip archives-pin-filter" aria-pressed={pinned} onClick={() => update({ pinned: !pinned })}>
          <Icon name="pin" size={14} />
          Épinglées
        </button>
      </div>

      <div className="cat-strip" role="group" aria-label="Filtrer par catégorie">
        <CategoryTile
          label="Toutes"
          count={totalArchived}
          placeholder={countPlaceholder}
          pressed={category === null}
          onClick={() => update({ category: null })}
        />
        {categories.map((c) => (
          <CategoryTile
            key={c.id}
            category={c}
            label={c.label}
            count={stats.data ? (counts.get(c.id) ?? 0) : null}
            placeholder={countPlaceholder}
            pressed={category === c.id}
            onClick={() => update({ category: category === c.id ? null : c.id })}
          />
        ))}
        {orphanCategories.map((s) => (
          <CategoryTile
            key={s.category}
            label={s.category}
            orphan
            count={s.conversations}
            placeholder={countPlaceholder}
            pressed={category === s.category}
            onClick={() => update({ category: category === s.category ? null : s.category })}
          />
        ))}
      </div>

      <div className="archives-countbar">
        <span aria-live="polite">{describeCount(list, search)}</span>
        {list && loading ? <Spinner label="Mise à jour de la liste" /> : null}
        <span className="spacer" />
        {active ? (
          <Button variant="ghost" size="sm" icon="x" onClick={resetFilters}>
            Réinitialiser les filtres
          </Button>
        ) : null}
      </div>

      <ArchiveResults
        list={list}
        error={error}
        loading={loading}
        loadingMore={loadingMore}
        searching={search !== ""}
        active={active}
        noArchiveYet={totalArchived === 0 || (totalArchived === null && !active)}
        rescanning={rescanning}
        onRetry={() => void load(PAGE_SIZE, false)}
        onRescan={() => void rescan()}
        onResetFilters={resetFilters}
        onLoadMore={() => void loadMore()}
      />
    </div>
  );
}

function ArchiveResults({
  list,
  error,
  loading,
  loadingMore,
  searching,
  active,
  noArchiveYet,
  rescanning,
  onRetry,
  onRescan,
  onResetFilters,
  onLoadMore,
}: {
  list: ArchiveList | null;
  error: unknown;
  loading: boolean;
  loadingMore: boolean;
  searching: boolean;
  active: boolean;
  noArchiveYet: boolean;
  rescanning: boolean;
  onRetry: () => void;
  onRescan: () => void;
  onResetFilters: () => void;
  onLoadMore: () => void;
}) {
  const { categoryById } = useApp();

  if (!list) {
    if (!error) {
      return (
        <div className="empty">
          <Spinner large />
          <p>Chargement des archives…</p>
        </div>
      );
    }
    return (
      <EmptyState
        icon="alert"
        title="Impossible de charger les archives"
        action={
          <Button icon="refresh" onClick={onRetry}>
            Réessayer
          </Button>
        }
      >
        {errorText(error)}
      </EmptyState>
    );
  }

  if (list.items.length === 0) {
    if (noArchiveYet) {
      return (
        <EmptyState
          icon="archive"
          title="Aucune archive pour l'instant"
          action={
            <Button variant="primary" icon="refresh" loading={rescanning} onClick={onRescan}>
              Réanalyser l'historique
            </Button>
          }
        >
          Les conversations sont archivées automatiquement dès qu'elles deviennent inactives. Vous pouvez aussi relire l'historique existant
          d'opencode.
        </EmptyState>
      );
    }
    const reset = active ? (
      <Button icon="x" onClick={onResetFilters}>
        Réinitialiser les filtres
      </Button>
    ) : undefined;
    return (
      <EmptyState icon="search" title="Aucun résultat" action={reset}>
        Aucune conversation ne correspond à ces critères.
      </EmptyState>
    );
  }

  const remaining = list.total - list.items.length;
  return (
    <>
      {error ? (
        <div className="callout critical archives-callout" role="alert">
          <Icon name="alert" />
          <span>Mise à jour impossible : {errorText(error)}</span>
        </div>
      ) : null}
      <div className="card flush archive-list" aria-busy={loading}>
        {list.items.map((c) => (
          <ArchiveRow key={c.sessionId} conversation={c} category={categoryById(c.category)} showSnippet={searching} />
        ))}
      </div>
      {remaining > 0 ? (
        <div className="archive-more">
          <Button icon="chevronDown" loading={loadingMore} disabled={loading} onClick={onLoadMore}>
            {`Charger plus (${plural(remaining, "restante", "restantes")})`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function CategoryTile({
  category,
  label,
  orphan = false,
  count,
  placeholder,
  pressed,
  onClick,
}: {
  category?: Category;
  label: string;
  orphan?: boolean;
  count: number | null;
  placeholder: string;
  pressed: boolean;
  onClick: () => void;
}) {
  const style = category ? ({ "--cat-color": category.color } as CSSProperties) : undefined;
  const description = orphan ? "Catégorie qui n'existe plus dans les paramètres" : category?.description;
  return (
    <button
      type="button"
      className={`cat-tile${count === 0 ? " is-empty" : ""}`}
      aria-pressed={pressed}
      title={description}
      style={style}
      onClick={onClick}
    >
      {category ? (
        <>
          <span className="swatch" />
          <span className="cat-emoji" aria-hidden>
            {category.emoji}
          </span>
        </>
      ) : (
        <Icon name={orphan ? "folder" : "layers"} size={14} />
      )}
      <span className="cat-label">{label}</span>
      <span className="cat-count">{count === null ? placeholder : formatInt(count)}</span>
    </button>
  );
}

function ArchiveRow({
  conversation: c,
  category,
  showSnippet,
}: {
  conversation: Conversation;
  category: Category | undefined;
  showSnippet: boolean;
}) {
  return (
    <a className="archive-row" href={routeHref("archives", c.sessionId)}>
      <div className="archive-row-main">
        <div className="archive-row-title">
          <CategoryChip category={category} fallback={c.category} />
          {c.pinned ? <Icon name="pin" size={14} className="archive-pin" title="Épinglée" /> : null}
          <strong className="ellipsis" title={c.title}>
            {c.title || "Sans titre"}
          </strong>
        </div>
        <div className="archive-meta-line">
          <span className="archive-meta-item" title={c.directory}>
            <Icon name="folder" size={13} />
            {c.project}
          </span>
          <span className="archive-meta-item" title={`Dernière activité : ${formatDateTime(c.updatedAt)}`}>
            <Icon name="clock" size={13} />
            {relativeTime(c.updatedAt)}
          </span>
          <span className="archive-meta-item">
            <Icon name="chat" size={13} />
            {plural(c.promptCount, "prompt", "prompts")}
          </span>
          {c.tags.length > 0 ? (
            <span className="archive-tags">
              {c.tags.map((tag, i) => (
                <span key={`${tag}-${i}`} className="badge">
                  #{tag}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
      <div className="archive-row-aside">
        <span className="archive-cost" title="Coût de la conversation">
          {formatUsd(c.cost)}
        </span>
        <span className="archive-badges">
          <ClassificationBadge conversation={c} />
          {c.deletedInOpencode ? <DeletedBadge /> : null}
        </span>
      </div>
      {showSnippet && c.snippet ? (
        <p className="archive-snippet">
          <Snippet text={c.snippet} />
        </p>
      ) : null}
    </a>
  );
}
