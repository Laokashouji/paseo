import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import {
  ArrowDown,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  CircleSlash,
  FileText,
  Folder,
  Square,
  XCircle,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { z } from "zod";
import type {
  CardAction,
  CardBadge,
  CardCarouselEntry,
  CardCarouselItemSchema,
  CardChecklistItemSchema,
  CardCodeItemSchema,
  CardDiffItemSchema,
  CardDividerItemSchema,
  CardEmptyItemSchema,
  CardFileTreeItemSchema,
  CardFileTreeNode,
  CardGridItemSchema,
  CardImageItemSchema,
  CardLoadingItemSchema,
  CardMarkdownItemSchema,
  CardMetricEntry,
  CardMetricItemSchema,
  CardProgressItemSchema,
  CardStatGridItemSchema,
  CardTableCell,
  CardTableColumn,
  CardTableItemSchema,
  CardTextItemSchema,
  CardTone,
} from "@getpaseo/protocol/interactive-cards";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { DiffViewer } from "@/components/diff-viewer";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { InteractiveCardChart, SparklineChart } from "./charts";
import { ThemedCardIcon } from "./icons";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedCheckDone = withUnistyles(CheckCircle2);
const ThemedInProgress = withUnistyles(CircleDot);
const ThemedPending = withUnistyles(Square);
const ThemedFailed = withUnistyles(XCircle);
const ThemedSkipped = withUnistyles(CircleSlash);
const ThemedTrendUp = withUnistyles(ArrowUpRight);
const ThemedTrendDown = withUnistyles(ArrowDown);
const ThemedFolder = withUnistyles(Folder);
const ThemedFile = withUnistyles(FileText);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.accent });

const PROGRESS_FILL_MAPPINGS: Record<CardTone | "none", (theme: Theme) => { fill: string }> = {
  none: (theme) => ({ fill: theme.colors.accent }),
  default: (theme) => ({ fill: theme.colors.foreground }),
  muted: (theme) => ({ fill: theme.colors.foregroundMuted }),
  accent: (theme) => ({ fill: theme.colors.accent }),
  success: (theme) => ({ fill: theme.colors.statusSuccess }),
  warning: (theme) => ({ fill: theme.colors.statusWarning }),
  danger: (theme) => ({ fill: theme.colors.statusDanger }),
};

const codeBlockMapping = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: {
    backgroundColor: theme.colors.surface2,
    padding: 10,
    borderRadius: theme.borderRadius.lg,
  },
});

export function cardToneToBadgeVariant(tone?: CardTone): StatusBadgeVariant {
  switch (tone) {
    case "success":
    case "accent":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "error";
    default:
      return "muted";
  }
}

export function CardBadgePill({ badge }: { badge?: CardBadge }) {
  if (!badge) return null;
  return <StatusBadge label={badge.label} variant={cardToneToBadgeVariant(badge.tone)} size="xs" />;
}

export function CardDividerView({ item }: { item: z.infer<typeof CardDividerItemSchema> }) {
  if (!item.label) {
    return <View style={styles.dividerLineOnly} />;
  }
  return (
    <View style={styles.dividerWithLabel}>
      <View style={styles.dividerLine} />
      <Text style={styles.dividerLabel}>{item.label}</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

export function CardLoadingView({ item }: { item: z.infer<typeof CardLoadingItemSchema> }) {
  const { t } = useTranslation();
  return (
    <View style={styles.loadingRow}>
      <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
      <Text style={styles.loadingText}>{item.label ?? t("interactiveCards.loading")}</Text>
    </View>
  );
}

export const CardEmptyView = memo(function CardEmptyView({
  item,
  disabled,
  onAction,
}: {
  item: z.infer<typeof CardEmptyItemSchema>;
  disabled: boolean;
  onAction: (action: CardAction) => void;
}) {
  const handlePress = useCallback(() => {
    if (item.action) onAction(item.action);
  }, [item.action, onAction]);
  return (
    <View style={styles.emptyBox}>
      {item.icon ? <ThemedCardIcon name={item.icon} tone="muted" size={22} /> : null}
      <Text style={styles.emptyTitle}>{item.title}</Text>
      {item.description ? <Text style={styles.emptyDesc}>{item.description}</Text> : null}
      {item.action ? (
        <Button variant="secondary" size="sm" disabled={disabled} onPress={handlePress}>
          {item.actionLabel ?? item.title}
        </Button>
      ) : null}
    </View>
  );
});

export function CardTextView({ item }: { item: z.infer<typeof CardTextItemSchema> }) {
  const textStyle = useMemo(
    () => [
      styles.textBase,
      item.size === "sm" && styles.textSm,
      item.size === "lg" && styles.textLg,
      item.mono && styles.textMono,
      item.tone === "muted" && styles.toneMuted,
      item.tone === "accent" && styles.toneAccent,
      item.tone === "success" && styles.toneSuccess,
      item.tone === "warning" && styles.toneWarning,
      item.tone === "danger" && styles.toneDanger,
    ],
    [item.mono, item.size, item.tone],
  );
  return (
    <View style={styles.paddedBlock}>
      <Text selectable style={textStyle}>
        {item.text}
      </Text>
    </View>
  );
}

export function CardMarkdownView({
  item,
  renderMarkdown,
}: {
  item: z.infer<typeof CardMarkdownItemSchema>;
  renderMarkdown: (content: string) => ReactNode;
}) {
  return <View style={styles.paddedBlock}>{renderMarkdown(item.content)}</View>;
}

const MetricBlock = memo(function MetricBlock({
  entry,
  compact,
}: {
  entry: CardMetricEntry;
  compact?: boolean;
}) {
  const boxStyle = useMemo(() => [styles.metricBox, compact && styles.metricBoxCompact], [compact]);
  const valueStyle = useMemo(
    () => [
      styles.metricValue,
      compact && styles.metricValueCompact,
      entry.tone === "accent" && styles.toneAccent,
      entry.tone === "success" && styles.toneSuccess,
      entry.tone === "warning" && styles.toneWarning,
      entry.tone === "danger" && styles.toneDanger,
    ],
    [compact, entry.tone],
  );
  const deltaStyle = useMemo(
    () => [
      styles.metricDelta,
      entry.trend === "up" && styles.toneSuccess,
      entry.trend === "down" && styles.toneDanger,
    ],
    [entry.trend],
  );
  return (
    <View style={boxStyle}>
      <Text style={styles.metricLabel} numberOfLines={1}>
        {entry.label}
      </Text>
      <View style={styles.metricValueRow}>
        <Text style={valueStyle} numberOfLines={1}>
          {entry.value}
          {entry.unit ? <Text style={styles.metricUnit}>{` ${entry.unit}`}</Text> : null}
        </Text>
        {entry.sparkline && entry.sparkline.length >= 2 ? (
          <SparklineChart values={entry.sparkline} tone={entry.tone} width={54} height={20} />
        ) : null}
      </View>
      {entry.delta ? (
        <View style={styles.metricDeltaRow}>
          {entry.trend === "up" ? <ThemedTrendUp size={12} uniProps={successColorMapping} /> : null}
          {entry.trend === "down" ? (
            <ThemedTrendDown size={12} uniProps={dangerColorMapping} />
          ) : null}
          <Text style={deltaStyle}>{entry.delta}</Text>
        </View>
      ) : null}
    </View>
  );
});

export function CardMetricView({ item }: { item: z.infer<typeof CardMetricItemSchema> }) {
  return (
    <View style={styles.paddedBlock}>
      <MetricBlock entry={item} />
    </View>
  );
}

export function CardStatGridView({ item }: { item: z.infer<typeof CardStatGridItemSchema> }) {
  const cellStyle =
    item.items.length >= 3 && item.items.length !== 4
      ? styles.statGridCellThree
      : styles.statGridCell;
  return (
    <View style={styles.statGrid}>
      {item.items.map((entry) => (
        <View key={entry.key ?? `${entry.label}:${entry.value}`} style={cellStyle}>
          <MetricBlock entry={entry} compact />
        </View>
      ))}
    </View>
  );
}

const ProgressFillBar = memo(function ProgressFillBar({
  pct,
  fill,
}: {
  pct: number;
  fill: string;
}) {
  const fillStyle = useMemo(
    () => [styles.progressFill, { width: `${pct}%` as const, backgroundColor: fill }],
    [fill, pct],
  );
  return <View style={fillStyle} />;
});

const ThemedProgressFillBar = withUnistyles(ProgressFillBar);

export function CardProgressView({ item }: { item: z.infer<typeof CardProgressItemSchema> }) {
  const max = item.max ?? (item.value <= 1 ? 1 : 100);
  let ratio = 0.35;
  if (!item.indeterminate) {
    ratio = max > 0 ? Math.max(0, Math.min(1, item.value / max)) : 0;
  }
  const pct = Math.round(ratio * 100);
  const display = item.displayValue ?? `${pct}%`;

  return (
    <View style={styles.paddedBlock}>
      <View style={styles.progressHeader}>
        {item.label ? <Text style={styles.progressLabel}>{item.label}</Text> : <View />}
        <Text style={styles.progressValue}>{display}</Text>
      </View>
      <View style={styles.progressTrack}>
        <ThemedProgressFillBar pct={pct} uniProps={PROGRESS_FILL_MAPPINGS[item.tone ?? "none"]} />
      </View>
    </View>
  );
}

function ChecklistStatusGlyph({
  status,
}: {
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
}) {
  if (status === "done") return <ThemedCheckDone size={15} uniProps={successColorMapping} />;
  if (status === "in_progress") return <ThemedInProgress size={15} uniProps={accentColorMapping} />;
  if (status === "failed") return <ThemedFailed size={15} uniProps={dangerColorMapping} />;
  if (status === "skipped") return <ThemedSkipped size={15} uniProps={extraMutedColorMapping} />;
  return <ThemedPending size={15} uniProps={mutedColorMapping} />;
}

export function CardChecklistView({ item }: { item: z.infer<typeof CardChecklistItemSchema> }) {
  const isSteps = item.variant === "steps";
  return (
    <View style={styles.checklistRoot}>
      {item.items.map((entry, idx) => {
        const isLast = idx === item.items.length - 1;
        return (
          <View key={entry.id ?? `${entry.label}:${entry.status}`} style={styles.checklistRow}>
            <View style={styles.checklistGutter}>
              <ChecklistStatusGlyph status={entry.status} />
              {isSteps && !isLast ? <View style={styles.stepConnector} /> : null}
            </View>
            <View style={styles.checklistBody}>
              <View style={styles.checklistLabelRow}>
                <Text
                  style={
                    entry.status === "skipped"
                      ? [styles.checklistLabel, styles.checklistSkipped]
                      : styles.checklistLabel
                  }
                >
                  {entry.label}
                </Text>
                <CardBadgePill badge={entry.badge} />
              </View>
              {entry.detail ? <Text style={styles.checklistDetail}>{entry.detail}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function cellDisplayText(cell: CardTableCell | undefined): string {
  if (cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number") return String(cell);
  return cell.text;
}

function cellSortValue(cell: CardTableCell | undefined): string | number {
  if (cell === undefined) return "";
  if (typeof cell === "number") return cell;
  const text = typeof cell === "string" ? cell : cell.text;
  const numeric = Number(text.replace(/[,%$]/g, ""));
  return Number.isFinite(numeric) && text.trim() !== "" ? numeric : text.toLowerCase();
}

function alignStyleForColumn(align: CardTableColumn["align"]) {
  if (align === "right") return styles.alignRight;
  if (align === "center") return styles.alignCenter;
  return styles.alignLeft;
}

const TableHeaderCell = memo(function TableHeaderCell({
  col,
  isPrimary,
  sortDir,
  onToggleSort,
}: {
  col: CardTableColumn;
  isPrimary: boolean;
  sortDir: "asc" | "desc" | null;
  onToggleSort: (key: string) => void;
}) {
  const handlePress = useCallback(() => {
    if (col.sortable) onToggleSort(col.key);
  }, [col.key, col.sortable, onToggleSort]);
  const boxStyle = useMemo(
    () => [styles.tableHeaderCellBox, isPrimary && styles.tableCellPrimary],
    [isPrimary],
  );
  const textStyle = useMemo(
    () => [styles.tableHeaderText, alignStyleForColumn(col.align)],
    [col.align],
  );
  let indicator = "";
  if (sortDir === "asc") indicator = " ▲";
  else if (sortDir === "desc") indicator = " ▼";
  return (
    <PressHighlight
      disabled={!col.sortable}
      onPress={handlePress}
      style={boxStyle}
      highlightStyle={styles.rowPressed}
    >
      <Text style={textStyle} numberOfLines={1}>
        {col.label}
        {indicator}
      </Text>
    </PressHighlight>
  );
});

function cellBoxAlignStyle(align?: "left" | "center" | "right") {
  if (align === "right") return styles.cellAlignEnd;
  if (align === "center") return styles.cellAlignCenter;
  return styles.cellAlignStart;
}

const TableBodyCell = memo(function TableBodyCell({
  col,
  cell,
  isPrimary,
}: {
  col: CardTableColumn;
  cell: CardTableCell | undefined;
  isPrimary: boolean;
}) {
  const obj = typeof cell === "object" && cell !== null ? cell : null;
  const boxStyle = useMemo(
    () => [styles.tableCell, isPrimary && styles.tableCellPrimary, cellBoxAlignStyle(col.align)],
    [col.align, isPrimary],
  );
  const textStyle = useMemo(
    () => [
      styles.tableCellText,
      alignStyleForColumn(col.align),
      obj?.mono && styles.textMono,
      obj?.tone === "muted" && styles.toneMuted,
      obj?.tone === "accent" && styles.toneAccent,
      obj?.tone === "success" && styles.toneSuccess,
      obj?.tone === "warning" && styles.toneWarning,
      obj?.tone === "danger" && styles.toneDanger,
    ],
    [col.align, obj?.mono, obj?.tone],
  );
  return (
    <View style={boxStyle}>
      {obj?.badge ? (
        <StatusBadge label={obj.text} variant={cardToneToBadgeVariant(obj.tone)} size="xs" />
      ) : (
        <Text selectable style={textStyle}>
          {cellDisplayText(cell)}
        </Text>
      )}
    </View>
  );
});

function buildTableRowKey(
  columns: readonly CardTableColumn[],
  row: Record<string, CardTableCell>,
  rowIdx: number,
): string {
  const parts: string[] = [];
  for (const col of columns) parts.push(cellDisplayText(row[col.key]));
  return `${parts.join("|")}:${rowIdx}`;
}

export const CardTableView = memo(function CardTableView({
  item,
}: {
  item: z.infer<typeof CardTableItemSchema>;
}) {
  const [sortState, setSortState] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const toggleSort = useCallback((colKey: string) => {
    setSortState((prev) => {
      if (!prev || prev.key !== colKey) return { key: colKey, dir: "asc" };
      if (prev.dir === "asc") return { key: colKey, dir: "desc" };
      return null;
    });
  }, []);

  const keyedRows = useMemo(() => {
    const entries = item.rows.map((row, rowIdx) => ({
      rowKey: buildTableRowKey(item.columns, row, rowIdx),
      row,
    }));
    if (!sortState) return entries;
    const { key, dir } = sortState;
    return [...entries].sort((a, b) => {
      const av = cellSortValue(a.row[key]);
      const bv = cellSortValue(b.row[key]);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
  }, [item.columns, item.rows, sortState]);

  return (
    <View style={styles.tableWrap} testID="interactive-card-table">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tableScrollContent}
      >
        <View style={styles.tableInner}>
          <View style={styles.tableHeaderRow}>
            {item.columns.map((col, idx) => (
              <TableHeaderCell
                key={col.key}
                col={col}
                isPrimary={idx === 0}
                sortDir={sortState?.key === col.key ? sortState.dir : null}
                onToggleSort={toggleSort}
              />
            ))}
          </View>
          {keyedRows.map(({ rowKey, row }) => (
            <View key={rowKey} style={styles.tableDataRow}>
              {item.columns.map((col, idx) => (
                <TableBodyCell key={col.key} col={col} cell={row[col.key]} isPrimary={idx === 0} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {item.caption ? <Text style={styles.tableCaption}>{item.caption}</Text> : null}
    </View>
  );
});

export function CardCodeView({ item }: { item: z.infer<typeof CardCodeItemSchema> }) {
  const code = useMemo(() => {
    if (!item.maxLines) return item.code;
    const lines = item.code.split("\n");
    return lines.length > item.maxLines
      ? `${lines.slice(0, item.maxLines).join("\n")}\n…`
      : item.code;
  }, [item.code, item.maxLines]);

  return (
    <View style={styles.paddedBlock}>
      {item.title ? <Text style={styles.subHeader}>{item.title}</Text> : null}
      <ThemedCodeBlock code={code} language={item.language} uniProps={codeBlockMapping} />
    </View>
  );
}

export function CardDiffView({ item }: { item: z.infer<typeof CardDiffItemSchema> }) {
  const diffLines = useMemo(() => parseUnifiedDiff(item.diff), [item.diff]);
  return (
    <View style={styles.paddedBlock}>
      {item.title || item.filePath ? (
        <Text style={styles.subHeader}>{item.title ?? item.filePath}</Text>
      ) : null}
      <View style={styles.diffBox}>
        <DiffViewer diffLines={diffLines} />
      </View>
    </View>
  );
}

const FileTreeRow = memo(function FileTreeRow({
  node,
  onOpenFilePath,
}: {
  node: CardFileTreeNode;
  onOpenFilePath?: (filePath: string) => void;
}) {
  const isDir = node.kind === "dir";
  const canOpen = !isDir && Boolean(onOpenFilePath);
  const handlePress = useCallback(() => {
    if (canOpen) onOpenFilePath?.(node.path);
  }, [canOpen, node.path, onOpenFilePath]);

  let statusTone: StatusBadgeVariant = "muted";
  if (node.status === "added") statusTone = "success";
  else if (node.status === "deleted") statusTone = "error";
  else if (node.status === "modified" || node.status === "renamed") statusTone = "warning";

  return (
    <PressHighlight
      disabled={!canOpen}
      onPress={handlePress}
      style={styles.fileTreeRow}
      highlightStyle={styles.rowPressed}
    >
      {isDir ? (
        <ThemedFolder size={14} uniProps={mutedColorMapping} />
      ) : (
        <ThemedFile size={14} uniProps={mutedColorMapping} />
      )}
      <View style={styles.fileTreeTextWrap}>
        <Text style={styles.fileTreePath} numberOfLines={1}>
          {node.label ?? node.path}
        </Text>
        {node.detail ? (
          <Text style={styles.fileTreeDetail} numberOfLines={1}>
            {node.detail}
          </Text>
        ) : null}
      </View>
      {node.status ? <StatusBadge label={node.status} variant={statusTone} size="xs" /> : null}
    </PressHighlight>
  );
});

export function CardFileTreeView({
  item,
  onOpenFilePath,
}: {
  item: z.infer<typeof CardFileTreeItemSchema>;
  onOpenFilePath?: (filePath: string) => void;
}) {
  return (
    <View style={styles.fileTreeRoot}>
      {item.title ? <Text style={styles.fileTreeTitle}>{item.title}</Text> : null}
      {item.nodes.map((node) => (
        <FileTreeRow
          key={`${node.path}:${node.kind ?? "file"}`}
          node={node}
          onOpenFilePath={onOpenFilePath}
        />
      ))}
    </View>
  );
}

export const CardImageView = memo(function CardImageView({
  item,
}: {
  item: z.infer<typeof CardImageItemSchema>;
}) {
  const [lightbox, setLightbox] = useState<ImageLightboxSource | null>(null);
  const imageSource = useMemo(() => ({ uri: item.src }), [item.src]);
  const imageStyle = useMemo(
    () => [styles.imageEl, { aspectRatio: item.aspectRatio ?? 16 / 9 }],
    [item.aspectRatio],
  );
  const handleOpen = useCallback(() => {
    setLightbox({ type: "uri", uri: item.src });
  }, [item.src]);
  const handleClose = useCallback(() => setLightbox(null), []);
  return (
    <View style={styles.paddedBlock}>
      <PressHighlight
        onPress={handleOpen}
        style={styles.imageFrame}
        highlightStyle={styles.rowPressed}
      >
        <Image
          source={imageSource}
          accessibilityLabel={item.alt ?? item.caption}
          resizeMode="cover"
          style={imageStyle}
        />
      </PressHighlight>
      {item.caption ? <Text style={styles.imageCaption}>{item.caption}</Text> : null}
      {lightbox ? <AttachmentLightbox source={lightbox} onClose={handleClose} /> : null}
    </View>
  );
});

export function CardGridView({
  item,
  renderChild,
}: {
  item: z.infer<typeof CardGridItemSchema>;
  renderChild: (
    child: z.infer<typeof CardGridItemSchema>["items"][number],
    idx: number,
  ) => ReactNode;
}) {
  const cols = item.columns ?? 2;
  const itemStyle = useMemo(
    () => [styles.gridItem, cols === 3 ? styles.gridItemThird : styles.gridItemHalf],
    [cols],
  );
  return (
    <View style={styles.gridContainer}>
      {item.items.map((child, idx) => (
        <View key={child.key ?? `${child.type}:${idx}`} style={itemStyle}>
          {renderChild(child, idx)}
        </View>
      ))}
    </View>
  );
}

const CarouselItemCard = memo(function CarouselItemCard({
  entry,
  disabled,
  onAction,
}: {
  entry: CardCarouselEntry;
  disabled: boolean;
  onAction: (action: CardAction) => void;
}) {
  const imageSource = useMemo(
    () => (entry.image ? { uri: entry.image } : undefined),
    [entry.image],
  );
  const handlePress = useCallback(() => {
    if (entry.action) onAction(entry.action);
  }, [entry.action, onAction]);
  return (
    <PressHighlight
      disabled={disabled || !entry.action}
      onPress={handlePress}
      style={styles.carouselCard}
      highlightStyle={styles.rowPressed}
    >
      {imageSource ? (
        <Image source={imageSource} resizeMode="cover" style={styles.carouselImage} />
      ) : null}
      <View style={styles.carouselBody}>
        <View style={styles.carouselHeader}>
          <Text style={styles.carouselTitle} numberOfLines={1}>
            {entry.title}
          </Text>
          <CardBadgePill badge={entry.badge} />
        </View>
        {entry.subtitle ? (
          <Text style={styles.carouselSubtitle} numberOfLines={2}>
            {entry.subtitle}
          </Text>
        ) : null}
        {entry.value ? <Text style={styles.carouselValue}>{entry.value}</Text> : null}
      </View>
    </PressHighlight>
  );
});

export function CardCarouselView({
  item,
  disabled,
  onAction,
}: {
  item: z.infer<typeof CardCarouselItemSchema>;
  disabled: boolean;
  onAction: (action: CardAction) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.carouselContent}
    >
      {item.items.map((entry, idx) => (
        <CarouselItemCard
          key={entry.key ?? `${entry.title}:${entry.value ?? ""}:${idx}`}
          entry={entry}
          disabled={disabled}
          onAction={onAction}
        />
      ))}
    </ScrollView>
  );
}

export { InteractiveCardChart };

const styles = StyleSheet.create((theme) => ({
  paddedBlock: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 10,
    gap: theme.spacing[1.5],
  },
  subHeader: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  dividerLineOnly: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  dividerWithLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  dividerLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  loadingText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  emptyBox: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    gap: theme.spacing[2],
  },
  emptyTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  emptyDesc: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  textBase: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13.5,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  textSm: {
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  textLg: {
    fontSize: theme.fontSize.lg,
    lineHeight: 23,
    fontWeight: theme.fontWeight.medium,
  },
  textMono: {
    fontFamily: theme.fontFamily.mono,
  },
  toneMuted: { color: theme.colors.foregroundMuted },
  toneAccent: { color: theme.colors.accent },
  toneSuccess: { color: theme.colors.statusSuccess },
  toneWarning: { color: theme.colors.statusWarning },
  toneDanger: { color: theme.colors.statusDanger },
  metricBox: {
    gap: 2,
  },
  metricBoxCompact: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  metricLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  metricValueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  metricValue: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  metricValueCompact: {
    fontSize: theme.fontSize.xl,
  },
  metricUnit: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  metricDeltaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginTop: 2,
  },
  metricDelta: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 11.5,
    color: theme.colors.foregroundMuted,
  },
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  statGridCell: {
    flexGrow: 1,
    flexBasis: "45%",
    minWidth: 120,
  },
  statGridCellThree: {
    flexGrow: 1,
    flexBasis: "30%",
    minWidth: 132,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  progressLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13,
    color: theme.colors.foreground,
    flex: 1,
  },
  progressValue: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  progressTrack: {
    height: 7,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  checklistRoot: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  checklistRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  checklistGutter: {
    alignItems: "center",
    paddingTop: 2,
    width: 18,
  },
  stepConnector: {
    width: 1.5,
    flex: 1,
    minHeight: 14,
    backgroundColor: theme.colors.border,
    marginTop: 4,
  },
  checklistBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
    paddingBottom: 2,
  },
  checklistLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  checklistLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13.5,
    color: theme.colors.foreground,
  },
  checklistSkipped: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  checklistDetail: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tableWrap: {
    paddingVertical: theme.spacing[2],
  },
  tableScrollContent: {
    flexGrow: 1,
    minWidth: "100%",
  },
  tableInner: {
    flex: 1,
    minWidth: "100%",
  },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
  },
  tableDataRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderAccent,
    paddingHorizontal: theme.spacing[2],
  },
  tableCell: {
    minWidth: 96,
    flex: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    justifyContent: "center",
  },
  tableCellPrimary: {
    minWidth: 150,
    flex: 1.6,
  },
  cellAlignStart: {
    alignItems: "flex-start",
  },
  cellAlignCenter: {
    alignItems: "center",
  },
  cellAlignEnd: {
    alignItems: "flex-end",
  },
  tableHeaderCellBox: {
    minWidth: 96,
    flex: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    justifyContent: "center",
  },
  tableHeaderText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  tableCellText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13,
    color: theme.colors.foreground,
  },
  alignLeft: { textAlign: "left" },
  alignCenter: { textAlign: "center" },
  alignRight: { textAlign: "right" },
  tableCaption: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[1.5],
  },
  diffBox: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    maxHeight: 280,
  },
  fileTreeRoot: {
    paddingVertical: theme.spacing[1.5],
  },
  fileTreeTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1],
  },
  fileTreeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  fileTreeTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  fileTreePath: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 12.5,
    color: theme.colors.foreground,
  },
  fileTreeDetail: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 11.5,
    color: theme.colors.foregroundMuted,
  },
  imageFrame: {
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  imageEl: {
    width: "100%",
  },
  imageCaption: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  gridContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  gridItem: {
    flexGrow: 1,
    minWidth: 140,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  gridItemHalf: { flexBasis: "46%" },
  gridItemThird: { flexBasis: "30%" },
  carouselContent: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  carouselCard: {
    width: 210,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  carouselImage: {
    width: "100%",
    height: 100,
    backgroundColor: theme.colors.surface2,
  },
  carouselBody: {
    padding: theme.spacing[3],
    gap: 4,
  },
  carouselHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  carouselTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13.5,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flex: 1,
  },
  carouselSubtitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  carouselValue: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 13,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accent,
    marginTop: 2,
  },
  rowPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
}));
