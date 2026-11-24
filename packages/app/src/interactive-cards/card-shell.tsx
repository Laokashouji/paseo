import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ArrowLeft, Check, CircleAlert, History, RefreshCw } from "lucide-react-native";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  extractDefaultFieldValues,
  INTERACTIVE_CARD_MAX_PAGE_DEPTH,
  isAllowedCardUrl,
  resolveCardPageSurface,
  type CardAction,
  type CardButtonItemSchema,
  type CardItem,
  type CardReplyAction,
  type CardSection,
  type InteractiveCardView,
} from "@getpaseo/protocol/interactive-cards";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isMainChatSessionLink, useMainChatSessionLinkOpener } from "@/main-chat/session-link";
import { openExternalUrl } from "@/utils/open-external-url";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";
import { InteractiveCardContext, useCardMarkdownRenderer, useInteractiveCardHost } from "./context";
import {
  CardCarouselView,
  CardChecklistView,
  CardCodeView,
  CardDiffView,
  CardDividerView,
  CardEmptyView,
  CardFileTreeView,
  CardGridView,
  CardImageView,
  CardLoadingView,
  CardMarkdownView,
  CardMetricView,
  CardProgressView,
  CardStatGridView,
  CardTableView,
  CardTextView,
  InteractiveCardChart,
} from "./display-items";
import {
  CardButtonGroupView,
  CardFieldView,
  CardLinkView,
  CardRowView,
  CardSegmentedView,
} from "./interactive-items";
import {
  getAgentCardsBucket,
  getCardDraft,
  popCardDraftPage,
  pushCardDraftPage,
  setCardDraftFieldValue,
  submitInteractiveCardAction,
  useInteractiveCardsStore,
} from "./store";

type CardButtonItem = z.infer<typeof CardButtonItemSchema>;

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedCheck = withUnistyles(Check);
const ThemedClock = withUnistyles(History);
const ThemedAlert = withUnistyles(CircleAlert);
const ThemedRetry = withUnistyles(RefreshCw);

const fgMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

interface PendingConfirmation {
  action: CardReplyAction;
  page: string;
  values: Record<string, string>;
  expectedVersion: number;
  prompt: string;
}

export interface InteractiveCardShellProps {
  cardKey: string;
  view: InteractiveCardView;
  version: number;
  live: boolean;
  /** Optional markdown renderer override; defaults to CardMarkdownRendererContext. */
  renderMarkdown?: (content: string) => ReactNode;
}

type RenderGroup =
  | { kind: "buttons"; items: CardButtonItem[]; key: string }
  | { kind: "item"; item: CardItem; key: string };

function itemGroupIdentity(item: CardItem, index: number): string {
  if (item.key) return item.key;
  if ("name" in item && typeof item.name === "string") return `${item.type}:${item.name}`;
  if ("title" in item && typeof item.title === "string")
    return `${item.type}:${item.title}:${index}`;
  return `${item.type}:${index}`;
}

function groupSectionItems(items: CardItem[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.type === "button") {
      const prev = groups[groups.length - 1];
      if (prev && prev.kind === "buttons") {
        prev.items.push(item);
      } else {
        groups.push({ kind: "buttons", items: [item], key: `btns:${item.action.id}` });
      }
    } else {
      groups.push({ kind: "item", item, key: itemGroupIdentity(item, i) });
    }
  }
  return groups;
}

const BoundFieldItem = memo(function BoundFieldItem({
  serverId,
  agentId,
  cardKey,
  item,
  value,
  locked,
  error,
}: {
  serverId: string;
  agentId: string;
  cardKey: string;
  item: Extract<CardItem, { type: "field" }>;
  value: string;
  locked: boolean;
  error?: string;
}) {
  const handleChange = useCallback(
    (next: string) => {
      if (serverId && agentId) {
        setCardDraftFieldValue(serverId, agentId, cardKey, item.name, next);
      }
    },
    [agentId, cardKey, item.name, serverId],
  );
  return (
    <CardFieldView
      item={item}
      value={value}
      locked={locked}
      error={error}
      onChange={handleChange}
    />
  );
});

const BoundSegmentedItem = memo(function BoundSegmentedItem({
  serverId,
  agentId,
  cardKey,
  item,
  value,
  locked,
  onAction,
}: {
  serverId: string;
  agentId: string;
  cardKey: string;
  item: Extract<CardItem, { type: "segmented" }>;
  value: string;
  locked: boolean;
  onAction: (action: CardAction, overrides?: Record<string, string>) => void;
}) {
  const handleChange = useCallback(
    (next: string) => {
      if (serverId && agentId) {
        setCardDraftFieldValue(serverId, agentId, cardKey, item.name, next);
      }
    },
    [agentId, cardKey, item.name, serverId],
  );
  const handleSegmentedAction = useCallback(
    (act: CardAction, nextVal: string) => {
      onAction(act, { [item.name]: nextVal });
    },
    [item.name, onAction],
  );
  return (
    <CardSegmentedView
      item={item}
      value={value}
      locked={locked}
      onChange={handleChange}
      onAction={item.action ? handleSegmentedAction : undefined}
    />
  );
});

function renderDisplayItem(
  item: CardItem,
  ctx: {
    actionsDisabled: boolean;
    nestedHostValue: ReturnType<typeof useInteractiveCardHost>;
    effectiveRenderMarkdown: (content: string) => ReactNode;
    chartOtherLabel: string;
    onOpenFilePath?: (filePath: string) => void;
    onAction: (action: CardAction, overrides?: Record<string, string>) => void;
  },
): ReactNode | undefined {
  switch (item.type) {
    case "divider":
      return <CardDividerView item={item} />;
    case "loading":
      return <CardLoadingView item={item} />;
    case "empty":
      return <CardEmptyView item={item} disabled={ctx.actionsDisabled} onAction={ctx.onAction} />;
    case "text":
      return <CardTextView item={item} />;
    case "markdown":
      return (
        <InteractiveCardContext.Provider value={ctx.nestedHostValue}>
          <CardMarkdownView item={item} renderMarkdown={ctx.effectiveRenderMarkdown} />
        </InteractiveCardContext.Provider>
      );
    case "metric":
      return <CardMetricView item={item} />;
    case "stat_grid":
      return <CardStatGridView item={item} />;
    case "progress":
      return <CardProgressView item={item} />;
    case "checklist":
      return <CardChecklistView item={item} />;
    case "table":
      return <CardTableView item={item} />;
    case "chart":
      return <InteractiveCardChart item={item} otherLabel={ctx.chartOtherLabel} />;
    case "code":
      return <CardCodeView item={item} />;
    case "diff":
      return <CardDiffView item={item} />;
    case "file_tree":
      return <CardFileTreeView item={item} onOpenFilePath={ctx.onOpenFilePath} />;
    case "image":
      return <CardImageView item={item} />;
    case "carousel":
      return (
        <CardCarouselView item={item} disabled={ctx.actionsDisabled} onAction={ctx.onAction} />
      );
    default:
      return undefined;
  }
}

const CardItemDispatcher = memo(function CardItemDispatcher({
  item,
  serverId,
  agentId,
  cardKey,
  actionsDisabled,
  fieldsLocked,
  chosenActionId,
  busyActionId,
  effectiveValues,
  fieldErrors,
  nestedHostValue,
  effectiveRenderMarkdown,
  chartOtherLabel,
  onOpenFilePath,
  onOpenUrl,
  onAction,
}: {
  item: CardItem;
  serverId: string;
  agentId: string;
  cardKey: string;
  actionsDisabled: boolean;
  fieldsLocked: boolean;
  chosenActionId?: string;
  busyActionId?: string;
  effectiveValues: Record<string, string>;
  fieldErrors?: Record<string, string>;
  nestedHostValue: ReturnType<typeof useInteractiveCardHost>;
  effectiveRenderMarkdown: (content: string) => ReactNode;
  chartOtherLabel: string;
  onOpenFilePath?: (filePath: string) => void;
  onOpenUrl: (url: string) => void;
  onAction: (action: CardAction, overrides?: Record<string, string>) => void;
}) {
  const renderGridChild = useCallback(
    (child: Extract<CardItem, { type: "grid" }>["items"][number]) => (
      <CardItemDispatcher
        item={child}
        serverId={serverId}
        agentId={agentId}
        cardKey={cardKey}
        actionsDisabled={actionsDisabled}
        fieldsLocked={fieldsLocked}
        chosenActionId={chosenActionId}
        busyActionId={busyActionId}
        effectiveValues={effectiveValues}
        fieldErrors={fieldErrors}
        nestedHostValue={nestedHostValue}
        effectiveRenderMarkdown={effectiveRenderMarkdown}
        chartOtherLabel={chartOtherLabel}
        onOpenFilePath={onOpenFilePath}
        onOpenUrl={onOpenUrl}
        onAction={onAction}
      />
    ),
    [
      actionsDisabled,
      agentId,
      busyActionId,
      cardKey,
      chartOtherLabel,
      chosenActionId,
      effectiveRenderMarkdown,
      effectiveValues,
      fieldErrors,
      fieldsLocked,
      nestedHostValue,
      onAction,
      onOpenFilePath,
      onOpenUrl,
      serverId,
    ],
  );

  const singleButtonList = useMemo(() => (item.type === "button" ? [item] : null), [item]);

  const displayNode = renderDisplayItem(item, {
    actionsDisabled,
    nestedHostValue,
    effectiveRenderMarkdown,
    chartOtherLabel,
    onOpenFilePath,
    onAction,
  });
  if (displayNode !== undefined) return displayNode;

  if (item.type === "grid") {
    return <CardGridView item={item} renderChild={renderGridChild} />;
  }
  if (item.type === "row") {
    return (
      <CardRowView
        item={item}
        disabled={actionsDisabled && item.action?.kind === "reply"}
        chosenActionId={chosenActionId}
        busyActionId={busyActionId}
        onAction={onAction}
      />
    );
  }
  if (item.type === "link") {
    return <CardLinkView item={item} onOpenUrl={onOpenUrl} />;
  }
  if (item.type === "segmented") {
    return (
      <BoundSegmentedItem
        serverId={serverId}
        agentId={agentId}
        cardKey={cardKey}
        item={item}
        value={effectiveValues[item.name] ?? ""}
        locked={fieldsLocked}
        onAction={onAction}
      />
    );
  }
  if (item.type === "field") {
    return (
      <BoundFieldItem
        serverId={serverId}
        agentId={agentId}
        cardKey={cardKey}
        item={item}
        value={effectiveValues[item.name] ?? ""}
        locked={fieldsLocked}
        error={fieldErrors?.[item.name]}
      />
    );
  }
  if (item.type !== "button" || !singleButtonList) return null;
  return (
    <CardButtonGroupView
      buttons={singleButtonList}
      disabled={actionsDisabled && item.action.kind === "reply"}
      chosenActionId={chosenActionId}
      busyActionId={busyActionId}
      onAction={onAction}
    />
  );
});

function resolveGroupWrapperStyle(needsRowHairline: boolean, isGridRow: boolean) {
  if (needsRowHairline && isGridRow) return styles.rowHairlineGridCell;
  if (needsRowHairline) return styles.rowHairline;
  if (isGridRow) return styles.sectionGridCell;
  return undefined;
}

const CardSectionBlock = memo(function CardSectionBlock({
  section,
  hasTopSeparator,
  serverId,
  agentId,
  cardKey,
  actionsDisabled,
  fieldsLocked,
  chosenActionId,
  busyActionId,
  effectiveValues,
  fieldErrors,
  nestedHostValue,
  effectiveRenderMarkdown,
  chartOtherLabel,
  onOpenFilePath,
  onOpenUrl,
  onAction,
}: {
  section: CardSection;
  hasTopSeparator: boolean;
  serverId: string;
  agentId: string;
  cardKey: string;
  actionsDisabled: boolean;
  fieldsLocked: boolean;
  chosenActionId?: string;
  busyActionId?: string;
  effectiveValues: Record<string, string>;
  fieldErrors?: Record<string, string>;
  nestedHostValue: ReturnType<typeof useInteractiveCardHost>;
  effectiveRenderMarkdown: (content: string) => ReactNode;
  chartOtherLabel: string;
  onOpenFilePath?: (filePath: string) => void;
  onOpenUrl: (url: string) => void;
  onAction: (action: CardAction, overrides?: Record<string, string>) => void;
}) {
  const groups = useMemo(() => groupSectionItems(section.items), [section.items]);
  const isRowListSection = useMemo(
    () => section.items.every((it) => it.type === "row"),
    [section.items],
  );
  const sectionStyle = useMemo(
    () => (hasTopSeparator ? styles.sectionSeparator : undefined),
    [hasTopSeparator],
  );

  return (
    <View style={sectionStyle}>
      {section.title || section.subtitle ? (
        <View style={styles.sectionHeader}>
          {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
          {section.subtitle ? <Text style={styles.sectionSubtitle}>{section.subtitle}</Text> : null}
        </View>
      ) : null}

      <View style={section.layout === "grid" ? styles.sectionGridLayout : undefined}>
        {groups.map((grp, gIdx) => {
          const needsRowHairline = isRowListSection && gIdx > 0 && section.layout !== "grid";
          const isGridRow =
            section.layout === "grid" && grp.kind === "item" && grp.item.type === "row";
          const wrapperStyle = resolveGroupWrapperStyle(needsRowHairline, isGridRow);

          return (
            <View key={grp.key} style={wrapperStyle}>
              {grp.kind === "buttons" ? (
                <CardButtonGroupView
                  buttons={grp.items}
                  disabled={actionsDisabled && grp.items.every((b) => b.action.kind === "reply")}
                  chosenActionId={chosenActionId}
                  busyActionId={busyActionId}
                  onAction={onAction}
                />
              ) : (
                <CardItemDispatcher
                  item={grp.item}
                  serverId={serverId}
                  agentId={agentId}
                  cardKey={cardKey}
                  actionsDisabled={actionsDisabled}
                  fieldsLocked={fieldsLocked}
                  chosenActionId={chosenActionId}
                  busyActionId={busyActionId}
                  effectiveValues={effectiveValues}
                  fieldErrors={fieldErrors}
                  nestedHostValue={nestedHostValue}
                  effectiveRenderMarkdown={effectiveRenderMarkdown}
                  chartOtherLabel={chartOtherLabel}
                  onOpenFilePath={onOpenFilePath}
                  onOpenUrl={onOpenUrl}
                  onAction={onAction}
                />
              )}
            </View>
          );
        })}
      </View>

      {section.footer ? <Text style={styles.sectionFooter}>{section.footer}</Text> : null}
    </View>
  );
});

function openInteractiveCardUrl(
  rawUrl: string,
  serverId: string,
  openSessionLink: (url: string) => unknown,
  onOpenFilePath?: (path: string) => void,
): void {
  const trimmed = rawUrl.trim();
  if (!isAllowedCardUrl(trimmed)) return;
  if (/^https:\/\//i.test(trimmed)) {
    void openExternalUrl(trimmed);
    return;
  }
  if (isMainChatSessionLink(trimmed)) {
    openSessionLink(trimmed);
    return;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol.toLowerCase() !== "paseo:") return;
    const targetKind = parsed.hostname.toLowerCase();
    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => decodeURIComponent(seg));
    if (targetKind === "file" && parts.length >= 1) {
      onOpenFilePath?.(parts.join("/"));
      return;
    }
    if (targetKind === "workspace" && parts.length >= 1 && serverId) {
      router.push(buildHostWorkspaceRoute(serverId, parts[0]!));
    }
  } catch {
    // Ignore malformed deep links
  }
}

const CardHeaderBar = memo(function CardHeaderBar({
  title,
  subtitle,
  canGoBack,
  onBack,
}: {
  title?: string;
  subtitle?: string;
  canGoBack: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  if (!title && !canGoBack) return null;
  return (
    <View style={styles.headerBar}>
      {canGoBack ? (
        <PressHighlight
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t("interactiveCards.back")}
          testID="interactive-card-back"
          style={styles.backButton}
          highlightStyle={styles.backButtonPressed}
        >
          <ThemedArrowLeft size={15} uniProps={fgMapping} />
        </PressHighlight>
      ) : null}
      <View style={styles.headerTextWrap}>
        {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
        {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      </View>
    </View>
  );
});

const CardNoticeBanners = memo(function CardNoticeBanners({
  changed,
  elsewhere,
  hostSupported,
}: {
  changed?: boolean;
  elsewhere?: boolean;
  hostSupported: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {changed ? (
        <View style={styles.noticeBannerWarning} testID="interactive-card-changed-banner">
          <ThemedAlert size={14} uniProps={warningMapping} />
          <Text style={styles.noticeTextWarning}>{t("interactiveCards.changedNotice")}</Text>
        </View>
      ) : null}
      {elsewhere ? (
        <View style={styles.noticeBannerMuted}>
          <Text style={styles.noticeTextMuted}>{t("interactiveCards.answeredElsewhere")}</Text>
        </View>
      ) : null}
      {!hostSupported ? (
        <View style={styles.noticeBannerMuted}>
          <Text style={styles.noticeTextMuted}>{t("interactiveCards.hostUnsupported")}</Text>
        </View>
      ) : null}
    </>
  );
});

const CardFooterStatus = memo(function CardFooterStatus({
  status,
  showRetry,
  retryError,
  onRetry,
}: {
  status?: "pending" | "sent" | "failed";
  showRetry: boolean;
  retryError?: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const retryIcon = useMemo(() => <ThemedRetry size={13} uniProps={fgMapping} />, []);
  return (
    <>
      {status && status !== "failed" ? (
        <View style={styles.statusFooter} testID="interactive-card-status">
          {status === "sent" ? (
            <ThemedCheck size={14} strokeWidth={2.2} uniProps={mutedMapping} />
          ) : (
            <ThemedClock size={14} uniProps={mutedMapping} />
          )}
          <Text style={styles.statusFooterText}>
            {status === "sent"
              ? t("interactiveCards.statusSent")
              : t("interactiveCards.statusPending")}
          </Text>
        </View>
      ) : null}
      {showRetry ? (
        <View style={styles.retryFooter} testID="interactive-card-retry-bar">
          <Text style={styles.retryErrorText}>
            {retryError ?? t("interactiveCards.statusFailed")}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            testID="interactive-card-retry"
            leftIcon={retryIcon}
            onPress={onRetry}
          >
            {t("interactiveCards.retry")}
          </Button>
        </View>
      ) : null}
    </>
  );
});

const CardConfirmModal = memo(function CardConfirmModal({
  pendingConfirm,
  onDismiss,
  onConfirm,
}: {
  pendingConfirm: PendingConfirmation | null;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      visible={Boolean(pendingConfirm)}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{t("interactiveCards.confirmTitle")}</Text>
          <Text style={styles.modalBody}>{pendingConfirm?.prompt}</Text>
          {pendingConfirm ? (
            <Text style={styles.modalPreview}>{pendingConfirm.action.reply}</Text>
          ) : null}
          <View style={styles.modalActions}>
            <Button variant="secondary" size="sm" onPress={onDismiss}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              testID="interactive-card-confirm-ok"
              onPress={onConfirm}
            >
              {t("interactiveCards.confirmOk")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
});

function resolveActivePageSurface(view: InteractiveCardView, pageStack: string[]) {
  const currentPageName = pageStack.at(-1) ?? "";
  const activePageDef = currentPageName ? view.pages?.[currentPageName] : undefined;
  return {
    currentPageName,
    activeTitle: activePageDef?.title ?? view.title,
    activeSubtitle: activePageDef?.subtitle ?? (currentPageName ? undefined : view.subtitle),
    activeSections: (activePageDef?.sections ?? view.sections) as CardSection[],
  };
}

function collectSubmissionValues(
  view: InteractiveCardView,
  page: string,
  action: CardReplyAction,
  effectiveValues: Record<string, string>,
  valuesOverride: Record<string, string> | undefined,
): Record<string, string> {
  const payloadValues: Record<string, string> = {};
  const surface = resolveCardPageSurface(view, page || undefined);
  if ((!action.submit && !valuesOverride) || !surface) return payloadValues;
  const source = valuesOverride ?? effectiveValues;
  for (const fieldName of surface.fields.keys()) {
    if (fieldName in source) payloadValues[fieldName] = source[fieldName]!;
  }
  return payloadValues;
}

function resolveCardRetryRequest(params: {
  draft: ReturnType<typeof getCardDraft>;
  committedAction: ReturnType<typeof getAgentCardsBucket>["actions"][string] | null;
}) {
  const { draft, committedAction } = params;
  const retryTarget = draft?.sending && !draft.sending.inFlight ? draft.sending : null;
  if (retryTarget) {
    return {
      actionId: retryTarget.actionId,
      page: retryTarget.page,
      values: retryTarget.values,
      expectedVersion: retryTarget.expectedVersion,
      confirmed: retryTarget.confirmed,
    };
  }
  if (committedAction?.status === "failed") {
    return {
      actionId: committedAction.actionId,
      page: committedAction.page ?? "",
      values: committedAction.values ?? {},
      expectedVersion: committedAction.version,
      confirmed: true,
    };
  }
  return null;
}

function resolveInteractiveAvailability(params: {
  host: ReturnType<typeof useInteractiveCardHost>;
  bucket: ReturnType<typeof getAgentCardsBucket> | null;
  serverId: string;
  agentId: string;
  cardKey: string;
  live?: boolean;
}) {
  const { host, bucket, serverId, agentId, cardKey, live } = params;
  const hostSupported = bucket ? bucket.supported : true;
  const hasHost = Boolean(host?.interactive && host.client && serverId && agentId);
  const keyRegistered = Boolean(live || bucket?.inlineBlockKeys[cardKey]);
  return { hostSupported, isInteractive: hasHost && hostSupported && keyRegistered };
}

function useCardShellHandlers(params: {
  host: ReturnType<typeof useInteractiveCardHost>;
  serverId: string;
  agentId: string;
  cardKey: string;
  view: InteractiveCardView;
  version: number;
  currentPageName: string;
  locked: boolean;
  effectiveValues: Record<string, string>;
  draft: ReturnType<typeof getCardDraft>;
  committedAction: ReturnType<typeof getAgentCardsBucket>["actions"][string] | null;
  confirmChangedBody: string;
  setPendingConfirm: React.Dispatch<React.SetStateAction<PendingConfirmation | null>>;
  pendingConfirm: PendingConfirmation | null;
}) {
  const {
    host,
    serverId,
    agentId,
    cardKey,
    view,
    version,
    currentPageName,
    locked,
    effectiveValues,
    draft,
    committedAction,
    confirmChangedBody,
    setPendingConfirm,
    pendingConfirm,
  } = params;

  const openSessionLink = useMainChatSessionLinkOpener(serverId || null);

  const handleOpenUrl = useCallback(
    (rawUrl: string) =>
      openInteractiveCardUrl(rawUrl, serverId, openSessionLink, host?.onOpenFilePath),
    [host?.onOpenFilePath, openSessionLink, serverId],
  );

  const executeReplySubmission = useCallback(
    async (
      action: CardReplyAction,
      page: string,
      valuesOverride: Record<string, string> | undefined,
      confirmed: boolean,
    ) => {
      if (!host?.client || !serverId || !agentId) return;
      const payloadValues = collectSubmissionValues(
        view,
        page,
        action,
        effectiveValues,
        valuesOverride,
      );
      await submitInteractiveCardAction({
        client: host.client,
        serverId,
        agentId,
        cardKey,
        actionId: action.id,
        page,
        values: payloadValues,
        expectedVersion: version,
        confirmed,
      });
    },
    [agentId, cardKey, effectiveValues, host?.client, serverId, version, view],
  );

  const handleAction = useCallback(
    (action: CardAction, overrides?: Record<string, string>) => {
      if (action.kind === "open") {
        handleOpenUrl(action.url);
        return;
      }
      if (action.kind === "push_page") {
        if (serverId && agentId && view.pages?.[action.page]) {
          pushCardDraftPage(
            serverId,
            agentId,
            cardKey,
            action.page,
            INTERACTIVE_CARD_MAX_PAGE_DEPTH,
          );
        }
        return;
      }
      if (action.kind === "pop_page") {
        if (serverId && agentId) popCardDraftPage(serverId, agentId, cardKey);
        return;
      }
      if (locked) return;

      const valuesSnapshot = overrides ? { ...effectiveValues, ...overrides } : effectiveValues;
      if (action.confirm || draft?.changed) {
        setPendingConfirm({
          action,
          page: currentPageName,
          values: valuesSnapshot,
          expectedVersion: version,
          prompt: action.confirm ?? confirmChangedBody,
        });
        return;
      }
      void executeReplySubmission(
        action,
        currentPageName,
        overrides ? valuesSnapshot : undefined,
        false,
      );
    },
    [
      agentId,
      cardKey,
      confirmChangedBody,
      currentPageName,
      draft?.changed,
      effectiveValues,
      executeReplySubmission,
      handleOpenUrl,
      locked,
      serverId,
      setPendingConfirm,
      version,
      view.pages,
    ],
  );

  const handleBackPress = useCallback(() => {
    if (serverId && agentId) popCardDraftPage(serverId, agentId, cardKey);
  }, [agentId, cardKey, serverId]);

  const handleDismissConfirm = useCallback(() => setPendingConfirm(null), [setPendingConfirm]);
  const handleAcceptConfirm = useCallback(() => {
    const snapshot = pendingConfirm;
    setPendingConfirm(null);
    if (snapshot) {
      void executeReplySubmission(snapshot.action, snapshot.page, snapshot.values, true);
    }
  }, [executeReplySubmission, pendingConfirm, setPendingConfirm]);

  const handleRetryFailed = useCallback(() => {
    if (!host?.client || !serverId || !agentId) return;
    const retryPayload = resolveCardRetryRequest({ draft, committedAction });
    if (!retryPayload) return;
    void submitInteractiveCardAction({
      client: host.client,
      serverId,
      agentId,
      cardKey,
      ...retryPayload,
    });
  }, [agentId, cardKey, committedAction, draft, host?.client, serverId]);

  return {
    handleOpenUrl,
    handleAction,
    handleBackPress,
    handleDismissConfirm,
    handleAcceptConfirm,
    handleRetryFailed,
  };
}

function resolveCardErrorBanner(
  draft: ReturnType<typeof getCardDraft>,
  committedAction: ReturnType<typeof getAgentCardsBucket>["actions"][string] | null,
  isSending: boolean,
) {
  const hasDraftSending = Boolean(draft?.sending);
  const failedCommit = committedAction?.status === "failed";
  const showRetryBanner = (hasDraftSending && !isSending) || failedCommit;
  const draftError = draft?.error;
  const inlineError = draftError && !showRetryBanner ? draftError : null;
  const retryError = draftError ?? committedAction?.error;
  return { showRetryBanner, inlineError, retryError };
}

function resolveCardShellFlags(params: {
  host: ReturnType<typeof useInteractiveCardHost>;
  bucket: ReturnType<typeof getAgentCardsBucket> | null;
  draft: ReturnType<typeof getCardDraft>;
  serverId: string;
  agentId: string;
  cardKey: string;
  live?: boolean;
}) {
  const { host, bucket, draft, serverId, agentId, cardKey, live } = params;
  const committedAction = bucket?.actions[cardKey] ?? null;
  const { hostSupported, isInteractive } = resolveInteractiveAvailability({
    host,
    bucket,
    serverId,
    agentId,
    cardKey,
    live,
  });
  const sending = draft?.sending;
  const isSending = Boolean(sending?.inFlight);
  const isAnswered = Boolean(committedAction && committedAction.status !== "failed");
  const locked = !isInteractive || isAnswered || isSending;
  const chosenActionId = isAnswered ? committedAction?.actionId : undefined;
  const busyActionId = isSending ? sending?.actionId : undefined;
  const errorState = resolveCardErrorBanner(draft, committedAction, isSending);
  return {
    committedAction,
    hostSupported,
    locked,
    chosenActionId,
    busyActionId,
    ...errorState,
  };
}

function useCardStoreSelectors(serverId: string, agentId: string, cardKey: string) {
  const bucket = useInteractiveCardsStore((s) =>
    serverId && agentId ? getAgentCardsBucket(serverId, agentId, s) : null,
  );
  const draft = useInteractiveCardsStore((s) =>
    serverId && agentId ? getCardDraft(serverId, agentId, cardKey, s) : undefined,
  );
  return { bucket, draft };
}

export const InteractiveCardShell = memo(function InteractiveCardShell({
  cardKey,
  view,
  version,
  live,
  renderMarkdown,
}: InteractiveCardShellProps) {
  const { t } = useTranslation();
  const host = useInteractiveCardHost();
  const contextMarkdownRenderer = useCardMarkdownRenderer();
  const effectiveRenderMarkdown = renderMarkdown ?? contextMarkdownRenderer;
  const serverId = host?.serverId ?? "";
  const agentId = host?.agentId ?? "";

  const { bucket, draft } = useCardStoreSelectors(serverId, agentId, cardKey);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);

  const pageStack = useMemo(() => {
    const raw = draft?.pageStack ?? [];
    return view.pages ? raw.filter((p) => Boolean(view.pages?.[p])) : [];
  }, [draft?.pageStack, view.pages]);

  const { currentPageName, activeTitle, activeSubtitle, activeSections } = resolveActivePageSurface(
    view,
    pageStack,
  );
  const {
    committedAction,
    hostSupported,
    locked,
    chosenActionId,
    busyActionId,
    showRetryBanner,
    inlineError,
    retryError,
  } = resolveCardShellFlags({
    host,
    bucket,
    draft,
    serverId,
    agentId,
    cardKey,
    live,
  });

  const defaultValues = useMemo(
    () => extractDefaultFieldValues(view, currentPageName || undefined),
    [view, currentPageName],
  );
  const effectiveValues = useMemo(
    () => ({ ...defaultValues, ...(committedAction?.values ?? draft?.values) }),
    [committedAction?.values, defaultValues, draft?.values],
  );

  const handlers = useCardShellHandlers({
    host,
    serverId,
    agentId,
    cardKey,
    view,
    version,
    currentPageName,
    locked,
    effectiveValues,
    draft,
    committedAction,
    confirmChangedBody: t("interactiveCards.confirmChangedBody"),
    setPendingConfirm,
    pendingConfirm,
  });

  const nestedHostValue = useMemo(() => (host ? { ...host, insideCard: true } : null), [host]);
  const chartOtherLabel = t("interactiveCards.chartOther");

  return (
    <View style={styles.outerWrap} testID={`interactive-card-${cardKey}`}>
      <CardHeaderBar
        title={activeTitle}
        subtitle={activeSubtitle}
        canGoBack={pageStack.length > 0}
        onBack={handlers.handleBackPress}
      />

      <View style={styles.cardSurface}>
        <CardNoticeBanners
          changed={draft?.changed}
          elsewhere={draft?.elsewhere}
          hostSupported={hostSupported}
        />

        {activeSections.map((section, sIdx) => (
          <CardSectionBlock
            key={section.id ?? `${section.title ?? "sec"}:${sIdx}`}
            section={section}
            hasTopSeparator={sIdx > 0}
            serverId={serverId}
            agentId={agentId}
            cardKey={cardKey}
            actionsDisabled={locked}
            fieldsLocked={locked}
            chosenActionId={chosenActionId}
            busyActionId={busyActionId}
            effectiveValues={effectiveValues}
            fieldErrors={draft?.fieldErrors}
            nestedHostValue={nestedHostValue}
            effectiveRenderMarkdown={effectiveRenderMarkdown}
            chartOtherLabel={chartOtherLabel}
            onOpenFilePath={host?.onOpenFilePath}
            onOpenUrl={handlers.handleOpenUrl}
            onAction={handlers.handleAction}
          />
        ))}

        {inlineError ? (
          <View style={styles.errorRow}>
            <Text style={styles.errorText}>{inlineError}</Text>
          </View>
        ) : null}
      </View>

      <CardFooterStatus
        status={committedAction?.status}
        showRetry={showRetryBanner}
        retryError={retryError}
        onRetry={handlers.handleRetryFailed}
      />

      <CardConfirmModal
        pendingConfirm={pendingConfirm}
        onDismiss={handlers.handleDismissConfirm}
        onConfirm={handlers.handleAcceptConfirm}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  outerWrap: {
    marginVertical: theme.spacing[2],
    gap: theme.spacing[2],
    width: "100%",
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  backButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  backButtonPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  headerTextWrap: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  cardTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 15,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  cardSubtitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12.5,
    color: theme.colors.foregroundMuted,
  },
  cardSurface: {
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  sectionSeparator: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  sectionHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    gap: 2,
  },
  sectionTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  sectionSubtitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  sectionFooter: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  sectionGridLayout: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  sectionGridCell: {
    flexBasis: "50%",
    minWidth: 220,
    flexGrow: 1,
  },
  rowHairline: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
  },
  rowHairlineGridCell: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
    flexBasis: "50%",
    minWidth: 220,
    flexGrow: 1,
  },
  noticeBannerWarning: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.statusWarningTint,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  noticeTextWarning: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
    flex: 1,
  },
  noticeBannerMuted: {
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  noticeTextMuted: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorRow: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  statusFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: 2,
  },
  statusFooterText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12.5,
    color: theme.colors.foregroundMuted,
  },
  retryFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.statusDangerTint,
  },
  retryErrorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modalTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  modalBody: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13.5,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  modalPreview: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
