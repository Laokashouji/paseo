import { memo, useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  INTERACTIVE_CARD_MAX_CHART_SLICES,
  type CardChartItemSchema,
  type CardChartSlice,
  type CardTone,
} from "@getpaseo/protocol/interactive-cards";
import type { z } from "zod";
import { baseColors, type Theme } from "@/styles/theme";
import { toneColorForTheme } from "./icons";

type CardChartItem = z.infer<typeof CardChartItemSchema>;

interface ChartPalette {
  seriesColors: string[];
  grid: string;
  label: string;
  surface: string;
  foreground: string;
  border: string;
}

function paletteFromTheme(theme: Theme): ChartPalette {
  const isDark = theme.colorScheme === "dark";
  return {
    seriesColors: [
      isDark ? baseColors.blue[400] : baseColors.blue[500],
      theme.colors.statusSuccess,
      baseColors.amber[500],
      baseColors.purple[500],
      theme.colors.statusDanger,
      baseColors.orange[500],
      baseColors.blue[300],
      baseColors.green[400],
    ],
    grid: theme.colors.border,
    label: theme.colors.foregroundMuted,
    surface: theme.colors.surface0,
    foreground: theme.colors.foreground,
    border: theme.colors.border,
  };
}

function formatNumber(val: number, unit?: string): string {
  let formatted: string;
  if (Number.isInteger(val)) {
    formatted = String(val);
  } else if (Math.abs(val) >= 100) {
    formatted = val.toFixed(1);
  } else {
    formatted = val.toFixed(2).replace(/\.?0+$/, "");
  }
  return unit ? `${formatted}${unit}` : formatted;
}

function resolveToneOrPaletteColor(
  palette: ChartPalette,
  index: number,
  tone: CardTone | undefined,
  toneColors: Record<CardTone, string>,
): string {
  if (tone && tone !== "default" && tone !== "muted") {
    return toneColors[tone];
  }
  return palette.seriesColors[index % palette.seriesColors.length]!;
}

// ── Sparkline ───────────────────────────────────────────────────────────────

function SparklineInner({
  values,
  width,
  height,
  stroke,
}: {
  values: number[];
  width: number;
  height: number;
  stroke: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (values.length - 1);
  const d = values
    .map((v, idx) => {
      const x = pad + idx * stepX;
      const y = height - pad - ((v - min) / span) * (height - pad * 2);
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <Svg width={width} height={height}>
      <Path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const ThemedSparklineInner = withUnistyles(SparklineInner);

const SPARKLINE_STROKE_MAPPINGS: Record<CardTone | "none", (theme: Theme) => { stroke: string }> = {
  none: (theme) => ({ stroke: theme.colors.accent }),
  default: (theme) => ({ stroke: theme.colors.foreground }),
  muted: (theme) => ({ stroke: theme.colors.foregroundMuted }),
  accent: (theme) => ({ stroke: theme.colors.accent }),
  success: (theme) => ({ stroke: theme.colors.statusSuccess }),
  warning: (theme) => ({ stroke: theme.colors.statusWarning }),
  danger: (theme) => ({ stroke: theme.colors.statusDanger }),
};

export const SparklineChart = memo(function SparklineChart({
  values,
  tone,
  width = 64,
  height = 22,
}: {
  values: number[];
  tone?: CardTone;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  return (
    <ThemedSparklineInner
      values={values}
      width={width}
      height={height}
      uniProps={SPARKLINE_STROKE_MAPPINGS[tone ?? "none"]}
    />
  );
});

// ── Shared Chart Sub-Components ─────────────────────────────────────────────

const chartThemeMapping = (theme: Theme) => ({
  palette: paletteFromTheme(theme),
  toneColors: {
    default: toneColorForTheme(theme, "default"),
    muted: toneColorForTheme(theme, "muted"),
    // Paseo's brand accent is green, which collides with statusSuccess inside multi-series charts.
    accent: theme.colorScheme === "dark" ? baseColors.blue[400] : baseColors.blue[500],
    success: toneColorForTheme(theme, "success"),
    warning: toneColorForTheme(theme, "warning"),
    danger: toneColorForTheme(theme, "danger"),
  } satisfies Record<CardTone, string>,
});

const LegendDot = memo(function LegendDot({ color }: { color: string }) {
  const dotStyle = useMemo(() => [styles.legendDot, { backgroundColor: color }], [color]);
  return <View style={dotStyle} />;
});

const PieSlicePath = memo(function PieSlicePath({
  d,
  color,
  index,
  selectedIndex,
  onSelectIndex,
}: {
  d: string;
  color: string;
  index: number;
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
}) {
  const handlePress = useCallback(() => {
    onSelectIndex(selectedIndex === index ? null : index);
  }, [index, onSelectIndex, selectedIndex]);
  return (
    <Path
      d={d}
      fill={color}
      opacity={selectedIndex === null || selectedIndex === index ? 1 : 0.45}
      onPress={handlePress}
    />
  );
});

const PieLegendRow = memo(function PieLegendRow({
  label,
  valueText,
  color,
  index,
  isSelected,
  onSelectIndex,
}: {
  label: string;
  valueText: string;
  color: string;
  index: number;
  isSelected: boolean;
  onSelectIndex: (index: number | null) => void;
}) {
  const handlePress = useCallback(() => {
    onSelectIndex(isSelected ? null : index);
  }, [index, isSelected, onSelectIndex]);
  const rowStyle = useMemo(
    () => [styles.pieLegendRow, isSelected && styles.pieLegendRowSelected],
    [isSelected],
  );
  return (
    <PressHighlight onPress={handlePress} style={rowStyle} highlightStyle={styles.rowPressed}>
      <LegendDot color={color} />
      <Text style={styles.legendLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.legendValue}>{valueText}</Text>
    </PressHighlight>
  );
});

const XAxisCategoryCell = memo(function XAxisCategoryCell({
  label,
  visible,
  index,
  isSelected,
  onSelectIndex,
}: {
  label: string;
  visible: boolean;
  index: number;
  isSelected: boolean;
  onSelectIndex: (index: number | null) => void;
}) {
  const handlePress = useCallback(() => {
    onSelectIndex(isSelected ? null : index);
  }, [index, isSelected, onSelectIndex]);
  const textStyle = useMemo(
    () => [styles.axisLabel, styles.xAxisLabel, isSelected && styles.xAxisLabelActive],
    [isSelected],
  );
  return (
    <PressHighlight
      onPress={handlePress}
      style={styles.xAxisCell}
      highlightStyle={styles.rowPressed}
    >
      <Text style={textStyle} numberOfLines={1}>
        {visible ? label : ""}
      </Text>
    </PressHighlight>
  );
});

const InteractiveBarGroup = memo(function InteractiveBarGroup({
  pointIndex,
  selectedIndex,
  onSelectIndex,
  rects,
}: {
  pointIndex: number;
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
  rects: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rx: number;
    fill: string;
  }>;
}) {
  const isSelected = selectedIndex === pointIndex;
  const handlePress = useCallback(() => {
    onSelectIndex(isSelected ? null : pointIndex);
  }, [isSelected, onSelectIndex, pointIndex]);
  const opacity = selectedIndex === null || isSelected ? 1 : 0.45;
  return (
    <G onPress={handlePress}>
      {rects.map((rect) => (
        <Rect
          key={rect.id}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={rect.rx}
          fill={rect.fill}
          opacity={opacity}
        />
      ))}
    </G>
  );
});

const InteractiveLineDot = memo(function InteractiveLineDot({
  cx,
  cy,
  pointIndex,
  selectedIndex,
  surface,
  color,
  onSelectIndex,
}: {
  cx: number;
  cy: number;
  pointIndex: number;
  selectedIndex: number | null;
  surface: string;
  color: string;
  onSelectIndex: (index: number | null) => void;
}) {
  const isSelected = selectedIndex === pointIndex;
  const handlePress = useCallback(() => {
    onSelectIndex(isSelected ? null : pointIndex);
  }, [isSelected, onSelectIndex, pointIndex]);
  return (
    <Circle
      cx={cx}
      cy={cy}
      r={isSelected ? 4.5 : 2.8}
      fill={surface}
      stroke={color}
      strokeWidth={2}
      onPress={handlePress}
    />
  );
});

// ── Geometry Helpers ────────────────────────────────────────────────────────

function aggregateSlices(slices: CardChartSlice[], otherLabel: string): CardChartSlice[] {
  if (slices.length <= INTERACTIVE_CARD_MAX_CHART_SLICES) return slices;
  const head = slices.slice(0, INTERACTIVE_CARD_MAX_CHART_SLICES - 1);
  const restSum = slices
    .slice(INTERACTIVE_CARD_MAX_CHART_SLICES - 1)
    .reduce((sum, s) => sum + s.value, 0);
  return [...head, { label: otherLabel, value: restSum, tone: "muted" }];
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcSlicePath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = Math.min(endAngle - startAngle, 359.95);
  const end = startAngle + sweep;
  const largeArc = sweep > 180 ? 1 : 0;
  const p1 = polarToCartesian(cx, cy, outerR, startAngle);
  const p2 = polarToCartesian(cx, cy, outerR, end);
  if (innerR <= 0) {
    return `M ${cx} ${cy} L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} Z`;
  }
  const p3 = polarToCartesian(cx, cy, innerR, end);
  const p4 = polarToCartesian(cx, cy, innerR, startAngle);
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

// ── Pie / Donut Subview ─────────────────────────────────────────────────────

const PieDonutBody = memo(function PieDonutBody({
  item,
  safeWidth,
  selectedIndex,
  onSelectIndex,
  palette,
  toneColors,
  otherLabel,
}: {
  item: CardChartItem;
  safeWidth: number;
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
  palette: ChartPalette;
  toneColors: Record<CardTone, string>;
  otherLabel: string;
}) {
  const slices = useMemo(
    () => aggregateSlices(item.slices ?? [], otherLabel),
    [item.slices, otherLabel],
  );
  const total = useMemo(() => slices.reduce((sum, s) => sum + s.value, 0), [slices]);
  const size = Math.min(180, Math.max(130, safeWidth * 0.44));
  const pieWrapStyle = useMemo(() => [styles.pieSvgWrap, { width: size, height: size }], [size]);

  const segments = useMemo(() => {
    if (total <= 0) return [];
    const cx = size / 2;
    const cy = size / 2;
    const outerR = size / 2 - 8;
    const innerR = item.chartType === "donut" ? outerR * 0.58 : 0;
    let cursorAngle = 0;
    return slices.map((slice, idx) => {
      const startAngle = cursorAngle;
      const deg = (slice.value / total) * 360;
      cursorAngle += deg;
      const pct = Math.round((slice.value / total) * 100);
      return {
        key: `${slice.label}:${slice.value}:${startAngle.toFixed(1)}`,
        slice,
        idx,
        valueText: `${formatNumber(slice.value, item.unit)} (${pct}%)`,
        color: resolveToneOrPaletteColor(palette, idx, slice.tone, toneColors),
        path: arcSlicePath(cx, cy, outerR, innerR, startAngle, startAngle + deg),
      };
    });
  }, [item.chartType, item.unit, palette, size, slices, toneColors, total]);

  if (total <= 0) return null;

  const activeSeg = selectedIndex !== null ? segments[selectedIndex] : null;
  const centerValue = activeSeg
    ? formatNumber(activeSeg.slice.value, item.unit)
    : item.center?.value;
  const centerLabel = activeSeg ? activeSeg.slice.label : item.center?.label;

  return (
    <View style={styles.pieContainer}>
      <View style={pieWrapStyle}>
        <Svg width={size} height={size}>
          {segments.map((seg) => (
            <PieSlicePath
              key={seg.key}
              d={seg.path}
              color={seg.color}
              index={seg.idx}
              selectedIndex={selectedIndex}
              onSelectIndex={onSelectIndex}
            />
          ))}
        </Svg>
        {item.chartType === "donut" && centerValue ? (
          <View pointerEvents="none" style={styles.donutCenterOverlay}>
            <Text style={styles.donutCenterValue} numberOfLines={1}>
              {centerValue}
            </Text>
            {centerLabel ? (
              <Text style={styles.donutCenterLabel} numberOfLines={1}>
                {centerLabel}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={styles.pieLegend}>
        {segments.map((seg) => (
          <PieLegendRow
            key={seg.key}
            label={seg.slice.label}
            valueText={seg.valueText}
            color={seg.color}
            index={seg.idx}
            isSelected={selectedIndex === seg.idx}
            onSelectIndex={onSelectIndex}
          />
        ))}
      </View>
    </View>
  );
});

// ── Cartesian (Bar / Line) Subview ──────────────────────────────────────────

function computeCartesianBounds(
  series: NonNullable<CardChartItem["series"]>,
  pointCount: number,
  stackedBar: boolean,
): { minVal: number; maxVal: number; range: number } {
  let minVal = 0;
  let maxVal = 0;
  if (stackedBar) {
    for (let i = 0; i < pointCount; i += 1) {
      let sumPos = 0;
      for (const s of series) sumPos += Math.max(0, s.values[i] ?? 0);
      if (sumPos > maxVal) maxVal = sumPos;
    }
  } else {
    const all = series.flatMap((s) => s.values);
    minVal = Math.min(0, ...all);
    maxVal = Math.max(0, ...all);
  }
  if (maxVal === minVal) maxVal = minVal + 1;
  return { minVal, maxVal, range: maxVal - minVal };
}

interface CartesianBarRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  fill: string;
}

interface CartesianBarGroup {
  key: string;
  pointIndex: number;
  rects: CartesianBarRect[];
}

function buildCartesianBarGroups(params: {
  series: NonNullable<CardChartItem["series"]>;
  categories: string[];
  colors: string[];
  pointCount: number;
  stacked: boolean;
  padLeft: number;
  slotW: number;
  yOf: (val: number) => number;
}): CartesianBarGroup[] {
  const { series, categories, colors, pointCount, stacked, padLeft, slotW, yOf } = params;
  const barGroups: CartesianBarGroup[] = [];
  for (let pIdx = 0; pIdx < pointCount; pIdx += 1) {
    const cat = categories[pIdx]!;
    const groupPad = Math.max(3, slotW * 0.16);
    const groupW = Math.max(4, slotW - groupPad * 2);
    const groupLeft = padLeft + slotW * pIdx + groupPad;
    const rects: CartesianBarRect[] = [];

    if (stacked) {
      let acc = 0;
      for (let sIdx = 0; sIdx < series.length; sIdx += 1) {
        const s = series[sIdx]!;
        const val = Math.max(0, s.values[pIdx] ?? 0);
        const yTop = yOf(acc + val);
        const yBot = yOf(acc);
        acc += val;
        rects.push({
          id: `${s.name}:${pIdx}`,
          x: groupLeft,
          y: yTop,
          width: groupW,
          height: Math.max(1, yBot - yTop),
          rx: sIdx === series.length - 1 ? 3 : 0,
          fill: colors[sIdx]!,
        });
      }
    } else {
      const barGap = series.length > 1 ? 2 : 0;
      const barW = Math.max(2, (groupW - barGap * (series.length - 1)) / series.length);
      const baseline = yOf(0);
      for (let sIdx = 0; sIdx < series.length; sIdx += 1) {
        const s = series[sIdx]!;
        const yVal = yOf(s.values[pIdx] ?? 0);
        rects.push({
          id: `${s.name}:${pIdx}`,
          x: groupLeft + sIdx * (barW + barGap),
          y: Math.min(yVal, baseline),
          width: barW,
          height: Math.max(1, Math.abs(baseline - yVal)),
          rx: 3,
          fill: colors[sIdx]!,
        });
      }
    }
    barGroups.push({ key: `bg:${cat}:${pIdx}`, pointIndex: pIdx, rects });
  }
  return barGroups;
}

function buildCartesianLines(params: {
  series: NonNullable<CardChartItem["series"]>;
  categories: string[];
  colors: string[];
  pointCount: number;
  area: boolean;
  baseline: number;
  xCenter: (idx: number) => number;
  yOf: (val: number) => number;
}) {
  const { series, categories, colors, pointCount, area, baseline, xCenter, yOf } = params;
  return series.map((s, sIdx) => {
    const color = colors[sIdx]!;
    const pts: Array<{ key: string; pointIndex: number; x: number; y: number }> = [];
    const pathParts: string[] = [];
    for (let pIdx = 0; pIdx < s.values.length; pIdx += 1) {
      const x = xCenter(pIdx);
      const y = yOf(s.values[pIdx] ?? 0);
      pts.push({ key: `${s.name}:${categories[pIdx]}:${pIdx}`, pointIndex: pIdx, x, y });
      pathParts.push(`${pIdx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const linePath = pathParts.join(" ");
    const areaPath =
      area && pts.length > 1
        ? `${linePath} L${pts[pts.length - 1]!.x.toFixed(1)},${baseline.toFixed(1)} L${pts[0]!.x.toFixed(1)},${baseline.toFixed(1)} Z`
        : null;
    return {
      key: `line:${s.name}:${sIdx}`,
      gradId: `cardAreaGrad_${sIdx}`,
      color,
      linePath,
      areaPath,
      pts: pointCount <= 36 ? pts : [],
    };
  });
}

function buildCartesianChartModel(params: {
  item: CardChartItem;
  safeWidth: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  palette: ChartPalette;
  toneColors: Record<CardTone, string>;
}) {
  const { item, safeWidth, height, padLeft, padRight, padTop, padBottom, palette, toneColors } =
    params;
  const series = item.series ?? [];
  const pointCount = series[0]?.values.length ?? 0;
  if (series.length === 0 || pointCount === 0) return null;

  const categories =
    item.categories && item.categories.length === pointCount
      ? item.categories
      : Array.from({ length: pointCount }, (_, i) => String(i + 1));

  const plotW = Math.max(120, safeWidth - padLeft - padRight);
  const plotH = height - padTop - padBottom;
  const colors = series.map((s, idx) =>
    resolveToneOrPaletteColor(palette, idx, s.tone, toneColors),
  );

  const { minVal, range } = computeCartesianBounds(
    series,
    pointCount,
    item.chartType === "bar" && Boolean(item.stacked),
  );

  const yOf = (val: number) => padTop + plotH - ((val - minVal) / range) * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    ratio: t,
    value: minVal + range * t,
    y: yOf(minVal + range * t),
  }));
  const labelStride = Math.max(1, Math.ceil(pointCount / Math.max(2, Math.floor(plotW / 54))));
  const slotW = plotW / pointCount;
  const xCenter = (idx: number) =>
    item.chartType === "line" && pointCount > 1
      ? padLeft + (idx / (pointCount - 1)) * plotW
      : padLeft + slotW * idx + slotW / 2;

  const barGroups =
    item.chartType === "bar"
      ? buildCartesianBarGroups({
          series,
          categories,
          colors,
          pointCount,
          stacked: Boolean(item.stacked),
          padLeft,
          slotW,
          yOf,
        })
      : [];

  const lines =
    item.chartType === "line"
      ? buildCartesianLines({
          series,
          categories,
          colors,
          pointCount,
          area: Boolean(item.area),
          baseline: yOf(minVal),
          xCenter,
          yOf,
        })
      : [];

  const categoryEntries = categories.map((label, idx) => ({
    key: `x:${label}:${idx}`,
    label,
    idx,
    visible: idx % labelStride === 0 || idx === pointCount - 1,
  }));

  return {
    series,
    colors,
    categories,
    categoryEntries,
    plotW,
    plotH,
    yTicks,
    reversedTicks: yTicks.toReversed(),
    xCenter,
    barGroups,
    lines,
  };
}

const CartesianChartBody = memo(function CartesianChartBody({
  item,
  safeWidth,
  selectedIndex,
  onSelectIndex,
  palette,
  toneColors,
}: {
  item: CardChartItem;
  safeWidth: number;
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
  palette: ChartPalette;
  toneColors: Record<CardTone, string>;
}) {
  const height = 164;
  const padLeft = 44;
  const padRight = 14;
  const padTop = 12;
  const padBottom = 8;

  const yAxisStyle = useMemo(
    () => [styles.yAxisColumn, { width: padLeft - 6, height }],
    [height, padLeft],
  );
  const xAxisStyle = useMemo(
    () => [styles.xAxisRow, { paddingLeft: padLeft, paddingRight: padRight }],
    [padLeft, padRight],
  );

  const model = useMemo(
    () =>
      buildCartesianChartModel({
        item,
        safeWidth,
        height,
        padLeft,
        padRight,
        padTop,
        padBottom,
        palette,
        toneColors,
      }),
    [height, item, padBottom, padLeft, padRight, padTop, palette, safeWidth, toneColors],
  );

  if (!model) return null;

  return (
    <View>
      <View style={styles.cartesianWrap}>
        <Svg width={safeWidth} height={height}>
          <Defs>
            {model.series.map((s, sIdx) => (
              <LinearGradient
                key={`grad:${s.name}`}
                id={`cardAreaGrad_${sIdx}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <Stop offset="0%" stopColor={model.colors[sIdx]!} stopOpacity={0.28} />
                <Stop offset="100%" stopColor={model.colors[sIdx]!} stopOpacity={0.02} />
              </LinearGradient>
            ))}
          </Defs>

          {model.yTicks.map((tick) => (
            <Line
              key={`grid:${tick.ratio}`}
              x1={padLeft}
              y1={tick.y}
              x2={padLeft + model.plotW}
              y2={tick.y}
              stroke={palette.grid}
              strokeWidth={1}
              strokeDasharray={tick.ratio === 0 ? undefined : "3 3"}
            />
          ))}

          {model.barGroups.map((group) => (
            <InteractiveBarGroup
              key={group.key}
              pointIndex={group.pointIndex}
              selectedIndex={selectedIndex}
              onSelectIndex={onSelectIndex}
              rects={group.rects}
            />
          ))}

          {model.lines.map((ln) => (
            <G key={ln.key}>
              {ln.areaPath ? <Path d={ln.areaPath} fill={`url(#${ln.gradId})`} /> : null}
              <Path
                d={ln.linePath}
                fill="none"
                stroke={ln.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {ln.pts.map((pt) => (
                <InteractiveLineDot
                  key={pt.key}
                  cx={pt.x}
                  cy={pt.y}
                  pointIndex={pt.pointIndex}
                  selectedIndex={selectedIndex}
                  surface={palette.surface}
                  color={ln.color}
                  onSelectIndex={onSelectIndex}
                />
              ))}
            </G>
          ))}

          {item.chartType === "line" && selectedIndex !== null ? (
            <Line
              x1={model.xCenter(selectedIndex)}
              y1={padTop}
              x2={model.xCenter(selectedIndex)}
              y2={padTop + model.plotH}
              stroke={palette.border}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          ) : null}
        </Svg>

        <View pointerEvents="none" style={yAxisStyle}>
          {model.reversedTicks.map((tick) => (
            <Text key={`yt:${tick.ratio}`} style={styles.axisLabel} numberOfLines={1}>
              {formatNumber(tick.value)}
            </Text>
          ))}
        </View>
      </View>

      <View style={xAxisStyle}>
        {model.categoryEntries.map((entry) => (
          <XAxisCategoryCell
            key={entry.key}
            label={entry.label}
            visible={entry.visible}
            index={entry.idx}
            isSelected={selectedIndex === entry.idx}
            onSelectIndex={onSelectIndex}
          />
        ))}
      </View>

      {selectedIndex !== null && model.categories[selectedIndex] !== undefined ? (
        <View style={styles.tooltipBar}>
          <Text style={styles.tooltipCategory}>{model.categories[selectedIndex]}</Text>
          <View style={styles.tooltipValues}>
            {model.series.map((s, sIdx) => (
              <View key={`tt:${s.name}`} style={styles.tooltipItem}>
                <LegendDot color={model.colors[sIdx]!} />
                <Text style={styles.tooltipText}>
                  {s.name}: {formatNumber(s.values[selectedIndex] ?? 0, item.unit)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {model.series.length > 1 ? (
        <View style={styles.legendRow}>
          {model.series.map((s, sIdx) => (
            <View key={`leg:${s.name}`} style={styles.legendChip}>
              <LegendDot color={model.colors[sIdx]!} />
              <Text style={styles.legendLabel}>{s.name}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

function ChartSvgBody({
  item,
  width,
  selectedIndex,
  onSelectIndex,
  palette,
  toneColors,
  otherLabel,
}: {
  item: CardChartItem;
  width: number;
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
  palette: ChartPalette;
  toneColors: Record<CardTone, string>;
  otherLabel: string;
}) {
  const safeWidth = Math.max(220, width);
  if (item.chartType === "pie" || item.chartType === "donut") {
    return (
      <PieDonutBody
        item={item}
        safeWidth={safeWidth}
        selectedIndex={selectedIndex}
        onSelectIndex={onSelectIndex}
        palette={palette}
        toneColors={toneColors}
        otherLabel={otherLabel}
      />
    );
  }
  return (
    <CartesianChartBody
      item={item}
      safeWidth={safeWidth}
      selectedIndex={selectedIndex}
      onSelectIndex={onSelectIndex}
      palette={palette}
      toneColors={toneColors}
    />
  );
}

const ThemedChartSvgBody = withUnistyles(ChartSvgBody);

export const InteractiveCardChart = memo(function InteractiveCardChart({
  item,
  otherLabel,
}: {
  item: CardChartItem;
  otherLabel: string;
}) {
  const [width, setWidth] = useState(320);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next > 0) {
      setWidth((prev) => (Math.abs(next - prev) >= 2 ? next : prev));
    }
  }, []);

  return (
    <View style={styles.chartRoot} testID="interactive-card-chart">
      {item.title ? <Text style={styles.chartTitle}>{item.title}</Text> : null}
      <View style={styles.chartPlotWrap} onLayout={handleLayout}>
        <ThemedChartSvgBody
          item={item}
          width={width}
          selectedIndex={selectedIndex}
          onSelectIndex={setSelectedIndex}
          otherLabel={otherLabel}
          uniProps={chartThemeMapping}
        />
      </View>
      {item.caption ? <Text style={styles.chartCaption}>{item.caption}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  chartRoot: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  chartPlotWrap: {
    width: "100%",
  },
  chartTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  chartCaption: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  pieContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  pieSvgWrap: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  donutCenterOverlay: {
    position: "absolute",
    inset: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  donutCenterValue: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 16,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  donutCenterLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 10.5,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  cartesianWrap: {
    position: "relative",
  },
  yAxisColumn: {
    position: "absolute",
    left: 0,
    top: 4,
    bottom: 2,
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  xAxisRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  xAxisCell: {
    flex: 1,
    alignItems: "center",
  },
  axisLabel: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
  xAxisLabel: {
    textAlign: "center",
  },
  xAxisLabelActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  pieLegend: {
    flex: 1,
    minWidth: 140,
    gap: theme.spacing[1.5],
  },
  pieLegendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 3,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  pieLegendRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  legendChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  legendLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  legendValue: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    marginLeft: "auto",
  },
  tooltipBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    marginTop: theme.spacing[1],
  },
  tooltipCategory: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  tooltipValues: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  tooltipItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  tooltipText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  rowPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
}));
