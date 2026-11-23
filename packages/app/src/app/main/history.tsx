import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { MainChatHistoryScreen } from "@/main-chat/history-screen";

export default function MainChatHistoryRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <MainChatHistoryScreen />
    </HostRouteBootstrapBoundary>
  );
}
