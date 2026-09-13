// Archives des conversations : liste filtrable (#/archives) et fiche détaillée (#/archives/<session>).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRoute } from "../lib/router.ts";
import { ArchiveDetailView } from "./archives/ArchiveDetail.tsx";
import { ArchiveListView } from "./archives/ArchiveList.tsx";
import { type ArchiveFilters, DEFAULT_FILTERS } from "./archives/shared.tsx";
import "./archives/archives.css";

export function ArchivesPage() {
  const route = useRoute();
  const sessionId = route[0] === "archives" ? route[1] : undefined;
  const [filters, setFilters] = useState<ArchiveFilters>(DEFAULT_FILTERS);
  const [refreshToken, setRefreshToken] = useState(0);

  // La liste reste montée (masquée) pendant la consultation d'une fiche : filtres, pages chargées
  // et position de défilement sont retrouvés au retour. Elle n'est chargée qu'à la première visite.
  const [listVisited, setListVisited] = useState(sessionId === undefined);
  const listPage = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);

  useEffect(() => {
    if (sessionId === undefined) setListVisited(true);
  }, [sessionId]);

  useLayoutEffect(() => {
    if (sessionId === undefined && listPage.current) listPage.current.scrollTop = listScroll.current;
  }, [sessionId]);

  const showList = listVisited || sessionId === undefined;

  return (
    <>
      {showList ? (
        <div
          ref={listPage}
          className="page"
          hidden={sessionId !== undefined}
          onScroll={(e) => {
            if (sessionId === undefined) listScroll.current = e.currentTarget.scrollTop;
          }}
        >
          <ArchiveListView filters={filters} setFilters={setFilters} refreshToken={refreshToken} />
        </div>
      ) : null}
      {sessionId !== undefined ? (
        <div key={sessionId} className="page">
          <ArchiveDetailView sessionId={sessionId} onDeleted={() => setRefreshToken((token) => token + 1)} />
        </div>
      ) : null}
    </>
  );
}
