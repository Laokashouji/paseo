import { useCallback } from "react";
import invariant from "tiny-invariant";
import { useMenuContext, type MenuFillPageDefinition } from "@/components/ui/menu";
import { usePaneContext } from "@/panels/pane-context";
import type { SheetTab } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useSheetPaneBridgeIfAny } from "./host";
import { SheetPane } from "./sheet-pane";

/**
 * Like `useSheetPanePage`, but returns `null` when rendered outside a `SheetPaneHostProvider`
 * (such as standalone `/main` conversations). Callers then fall back to non-sheet row actions.
 */
export function useSheetPanePageIfAny(): ((sheet: SheetTab) => MenuFillPageDefinition) | null {
  const bridge = useSheetPaneBridgeIfAny();
  const { target: opener } = usePaneContext();
  const buildPage = useCallback(
    (sheet: SheetTab): MenuFillPageDefinition => {
      invariant(bridge, "SheetPaneHostProvider is required");
      return {
        id: sheet.tab.tabId,
        fill: true as const,
        content: bridge(
          // Keyed like the detached container, so the panel's descriptor hook stays fixed per page.
          <MenuSheetPane
            key={`${sheet.tab.tabId}:${sheet.tab.target.kind}`}
            sheet={sheet}
            opener={opener}
          />,
        ),
      };
    },
    [bridge, opener],
  );
  return bridge ? buildPage : null;
}

/**
 * Shows sheet tabs as pages of a menu opened from a pane, so a row's sheet replaces the list it
 * was chosen from instead of stacking a second sheet over it. Back returns to the list; Close
 * closes the menu, which uncovers the pane the menu was opened from.
 */
export function useSheetPanePage(): (sheet: SheetTab) => MenuFillPageDefinition {
  const page = useSheetPanePageIfAny();
  invariant(page, "SheetPaneHostProvider is required");
  return page;
}

function MenuSheetPane({ sheet, opener }: { sheet: SheetTab; opener: WorkspaceTabTarget }) {
  const { setOpen, goBack } = useMenuContext("MenuSheetPane");
  const close = useCallback(() => setOpen(false), [setOpen]);
  return <SheetPane sheet={sheet} onClose={close} onBack={goBack} opener={opener} isTop />;
}
