import { useCallback, useEffect, useState } from "react";
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

export function useWorkbenchCard(agentId: string, workspaceId: string | null) {
  const fetchCard = useRpc(getCardRpc);
  const [card, setCard] = useState<SessionWorkbenchCard>(() =>
    createEmptyCard({ agentId, workspaceId }),
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setCard(createEmptyCard({ agentId, workspaceId }));
    setLoaded(false);
    let active = true;
    void fetchCard({ agentId, workspaceId })
      .then((result) => {
        if (!active) return;
        setCard(result.card);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [agentId, workspaceId, fetchCard]);

  const handleEvent = useCallback((event: { card: SessionWorkbenchCard }) => {
    setCard(event.card);
    setLoaded(true);
  }, []);

  useSubscription(cardSubscription, { agentId, workspaceId }, handleEvent);

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
