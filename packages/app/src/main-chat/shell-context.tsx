import { createContext, useContext, type ReactNode } from "react";
import { buildMainChatRoute } from "@/utils/host-routes";

export interface MainChatShellContextValue {
  inMainChatShell: boolean;
  originRoute: string;
  originTitle: string;
}

const DEFAULT_MAIN_CHAT_SHELL_CONTEXT: MainChatShellContextValue = {
  inMainChatShell: false,
  originRoute: buildMainChatRoute(),
  originTitle: "",
};

const MainChatShellContext = createContext<MainChatShellContextValue>(
  DEFAULT_MAIN_CHAT_SHELL_CONTEXT,
);

export function MainChatShellProvider({
  value,
  children,
}: {
  value: MainChatShellContextValue;
  children: ReactNode;
}) {
  return <MainChatShellContext.Provider value={value}>{children}</MainChatShellContext.Provider>;
}

export function useMainChatShellContext(): MainChatShellContextValue {
  return useContext(MainChatShellContext);
}
