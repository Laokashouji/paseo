import React, { createContext, useCallback, useContext, type ReactNode } from "react";
import invariant from "tiny-invariant";
import { NavigationContext, NavigationRouteContext } from "expo-router/react-navigation";
import { useAssistantFileLinkEnvironmentBridge } from "@/assistant-file-links";
import { useForgeShorthandBridge } from "@/git/forge-shorthand";
import { useComposerEditingEnvironmentBridge } from "@/composer/editing-session";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { useDiffDocumentWorkspaceCacheBridgeIfAny } from "@/git/diff-document/workspace-cache";
import { HostRouteProvider, useHostRouteServerId } from "@/navigation/host-route-context";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

/** What a sheet pane needs from the workspace it shows a tab of. */
export interface SheetPaneHost {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  isWorkspaceFocused: boolean;
  /** The pane content for a sheet's tab. Closing the tab from inside it runs `closeCurrentTab`. */
  buildContent: (
    tab: WorkspaceTabDescriptor,
    closeCurrentTab: () => void,
  ) => WorkspacePaneContentModel;
}

const SheetPaneHostContext = createContext<SheetPaneHost | null>(null);

/** `null` while there is no workspace to show sheets for. */
export function SheetPaneHostProvider({
  value,
  children,
}: {
  value: SheetPaneHost | null;
  children: ReactNode;
}) {
  return <SheetPaneHostContext.Provider value={value}>{children}</SheetPaneHostContext.Provider>;
}

/** The host of the workspace the caller is in, or null while there is none. */
export function useSheetPaneHostIfAny(): SheetPaneHost | null {
  return useContext(SheetPaneHostContext);
}

export function useSheetPaneHost(): SheetPaneHost {
  const host = useSheetPaneHostIfAny();
  invariant(host, "SheetPaneHostProvider is required");
  return host;
}

/**
 * Like `useSheetPaneBridge`, but returns `null` outside a `SheetPaneHostProvider` (for example in
 * standalone `/main` panes that host `AgentConversationPanel` without `WorkspaceScreen`).
 */
export function useSheetPaneBridgeIfAny(): ContextBridge | null {
  const host = useSheetPaneHostIfAny();
  const editing = useComposerEditingEnvironmentBridge();
  const cache = useDiffDocumentWorkspaceCacheBridgeIfAny();
  const files = useAssistantFileLinkEnvironmentBridge();
  const forgeShorthand = useForgeShorthandBridge();
  const active = useRetainedPanelActive();
  const serverId = useHostRouteServerId();
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  const bridge = useCallback<ContextBridge>(
    (children) => {
      const content = editing(cache(files(forgeShorthand(children))));
      return (
        <SheetPaneHostContext.Provider value={host}>
          <NavigationContext.Provider value={navigation}>
            <NavigationRouteContext.Provider value={route}>
              <RetainedPanelActivity active={active}>
                {serverId ? (
                  <HostRouteProvider serverId={serverId}>{content}</HostRouteProvider>
                ) : (
                  content
                )}
              </RetainedPanelActivity>
            </NavigationRouteContext.Provider>
          </NavigationContext.Provider>
        </SheetPaneHostContext.Provider>
      );
    },
    [host, editing, cache, files, forgeShorthand, active, serverId, navigation, route],
  );
  return host ? bridge : null;
}

/**
 * Carries a sheet pane's environment across the portal into the app overlay host: the workspace
 * host, and the environment of the built-in panels. Pane identity is supplied by the pane itself.
 */
export function useSheetPaneBridge(): ContextBridge {
  const bridge = useSheetPaneBridgeIfAny();
  invariant(bridge, "SheetPaneHostProvider is required");
  return bridge;
}
