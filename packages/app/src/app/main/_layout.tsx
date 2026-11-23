import { Stack } from "expo-router";
import { ThemedStack } from "@/navigation/themed-stack";

const MAIN_CHAT_STACK_SCREEN_OPTIONS = {
  headerShown: false,
  animation: "none" as const,
};

export default function MainChatRouteLayout() {
  return (
    <ThemedStack screenOptions={MAIN_CHAT_STACK_SCREEN_OPTIONS}>
      <Stack.Screen name="index" />
      <Stack.Screen name="c/[conversationId]" />
      <Stack.Screen name="history" />
    </ThemedStack>
  );
}
