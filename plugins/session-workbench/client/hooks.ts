import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useSettings, useSubscription } from "@getpaseo/plugin/client";
import {
  cardSubscription,
  getCardRpc,
  getOverviewRpc,
  overviewSubscription,
} from "../shared/rpc.js";
import {
  createEmptyCard,
  type OverviewSnapshot,
  type SessionWorkbenchCard,
} from "../shared/schema.js";
import { DEFAULT_WORKBENCH_SETTINGS, workbenchSettings, type WorkbenchSettings } from "../shared/settings.js";

export function useWorkbenchSettingsValues(): WorkbenchSettings {
  const state = useSettings(workbenchSettings);
  return state.status === "ready" ? state.values : DEFAULT_WORKBENCH_SETTINGS;
}

function isNewerOrEqualCard(candidate: SessionWorkbenchCard, current: SessionWorkbenchCard): boolean {
  if (candidate.agentId !== current.agentId) return true;
  if (!current.updatedAt) return true;
  return candidate.updatedAt >= current.updatedAt;
}

export function useWorkbenchCard(agentId: string, workspaceId: string | null) {
  const fetchCard = useRpc(getCardRpc);
  const [card, setCard] = useState<SessionWorkbenchCard>(() =>
    createEmptyCard({ agentId, workspaceId }),
  );
  const [loaded, setLoaded] = useState(false);
  const hasServerStateRef = useRef(false);

  const applyServerCard = useCallback((next: SessionWorkbenchCard) => {
    if (next.agentId !== agentId) return;
    setCard((prev) => {
      if (!hasServerStateRef.current || isNewerOrEqualCard(next, prev)) {
        hasServerStateRef.current = true;
        return next;
      }
      return prev;
    });
    setLoaded(true);
  }, [agentId]);

  useEffect(() => {
    hasServerStateRef.current = false;
    setCard(createEmptyCard({ agentId, workspaceId }));
    setLoaded(false);
    let active = true;
    void fetchCard({ agentId, workspaceId })
      .then((result) => {
        if (!active) return;
        applyServerCard(result.card);
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [agentId, workspaceId, fetchCard, applyServerCard]);

  const handleEvent = useCallback(
    (event: { card: SessionWorkbenchCard }) => {
      applyServerCard(event.card);
    },
    [applyServerCard],
  );

  const subState = useSubscription(cardSubscription, { agentId, workspaceId }, handleEvent);

  useEffect(() => {
    if (subState.status !== "closed" && subState.status !== "error") return;
    let active = true;
    const timer = setTimeout(() => {
      void fetchCard({ agentId, workspaceId })
        .then((result) => {
          if (active) applyServerCard(result.card);
        })
        .catch(() => {});
    }, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [subState.status, agentId, workspaceId, fetchCard, applyServerCard]);

  return { card, setCard, loaded };
}

export function useWorkbenchOverview(includeArchived = false) {
  const fetchOverview = useRpc(getOverviewRpc);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>({
    cards: [],
    counts: {
      total: 0,
      active: 0,
      waitingMe: 0,
      waitingExternal: 0,
      waitingDependency: 0,
      snoozed: 0,
      done: 0,
      readyToAdvance: 0,
      openTodos: 0,
      openBlockers: 0,
    },
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchOverview({ includeArchived })
      .then((result) => {
        if (!active) return;
        setSnapshot(result);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [fetchOverview, includeArchived]);

  const handleEvent = useCallback((event: OverviewSnapshot) => {
    setSnapshot(event);
    setLoaded(true);
  }, []);

  useSubscription(overviewSubscription, { includeArchived }, handleEvent);

  return { snapshot, loaded };
}
