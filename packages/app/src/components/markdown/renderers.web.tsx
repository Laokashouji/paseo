import { Text } from "react-native";
import {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAssistantFileLinkEnvironment, useFileLink } from "@/assistant-file-links";
import { MARKDOWN_COPY_RECOGNIZED_LINK_ATTRIBUTE } from "@/assistant-selection-copy/markup";
import { useForgeShorthand } from "@/git/forge-shorthand";
import {
  parseMainChatSessionLink,
  useMainChatSessionLinkMeta,
  useMainChatSessionLinkOpener,
  type ParsedMainChatSessionLink,
} from "@/main-chat/session-link";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import { MermaidFence } from "./fence/mermaid";
import { isRecognizedLink, markdownLinkSource } from "./source";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <ThemedCodeBlock code={code} language={language} uniProps={codeStyle} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;
const SESSION_LINK_UNDERLINE_ALPHA = 0.38;

function applyColorAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed);
  if (hexMatch) {
    const raw = hexMatch[1]!;
    const hex =
      raw.length === 3 ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}` : raw.slice(0, 6);
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }
  return `color-mix(in srgb, ${trimmed} ${Math.round(alpha * 100)}%, transparent)`;
}

function hasBrowserOpenModifier(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function WebSessionLink({
  parsed,
  anchorProps,
  children,
}: {
  parsed: ParsedMainChatSessionLink;
  anchorProps: LinkRendererProps["anchorProps"];
  children: LinkRendererProps["children"];
}) {
  const environment = useAssistantFileLinkEnvironment();
  const { resolution, webHref, tooltip } = useMainChatSessionLinkMeta(parsed, environment.serverId);
  const openSessionLink = useMainChatSessionLinkOpener(environment.serverId);
  const [hovered, setHovered] = useState(false);

  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Preserve native browser Cmd/Ctrl/Shift/Alt/middle-click new-tab behavior when we have
      // a valid in-app route href — without calling anchorProps.onClick (which prevents default).
      if (hasBrowserOpenModifier(event)) {
        if (webHref) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openSessionLink(parsed.rawUrl);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      openSessionLink(parsed.rawUrl);
    },
    [openSessionLink, parsed.rawUrl, webHref],
  );

  const handleAuxClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Middle-click with a resolved in-app href lets the browser open a new tab natively;
      // unresolved links never fall through to an external protocol prompt.
      if (event.button === 1 && !webHref) {
        event.preventDefault();
        event.stopPropagation();
        openSessionLink(parsed.rawUrl);
      }
    },
    [openSessionLink, parsed.rawUrl, webHref],
  );

  const accentColor = String(styles.sessionLinkAccent.color);
  const mutedUnderline = useMemo(
    () => applyColorAlpha(accentColor, SESSION_LINK_UNDERLINE_ALPHA),
    [accentColor],
  );

  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      color: accentColor,
      overflowWrap: "anywhere" as const,
      textDecorationLine: "underline" as const,
      textDecorationStyle: "solid" as const,
      textDecorationThickness: "1px",
      textUnderlineOffset: "3px",
      textDecorationColor: hovered ? accentColor : mutedUnderline,
      transition: "text-decoration-color 150ms ease, color 150ms ease",
      cursor: "pointer" as const,
    }),
    [accentColor, anchorProps.style, hovered, mutedUnderline],
  );

  const { onClick: _ignoredOnClick, href: _ignoredHref, ...restAnchorProps } = anchorProps;

  const anchor = (
    <a
      {...restAnchorProps}
      href={webHref ?? "#session-link"}
      style={anchorStyle}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-session-link="true"
      data-session-link-status={resolution.status}
      data-testid="main-chat-session-link"
    >
      {children}
    </a>
  );

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const sessionLink = useMemo(() => parseMainChatSessionLink(link.url), [link.url]);
  if (sessionLink) {
    return (
      <WebSessionLink parsed={sessionLink} anchorProps={anchorProps}>
        {children}
      </WebSessionLink>
    );
  }
  return (
    <WebStandardLink link={link} anchorProps={anchorProps}>
      {children}
    </WebStandardLink>
  );
}

function WebStandardLink({ link, anchorProps, children }: LinkRendererProps) {
  const forgeShorthand = useForgeShorthand();
  // A forge reference like `#12` carries its web URL so hover, copy and new-tab opens work.
  const forgeUrl = link.sourceType === "text" ? forgeShorthand?.resolve(link.url) : null;
  const { tooltipPath, onHoverIn } = useFileLink(
    forgeUrl ? markdownLinkSource(forgeUrl) : markdownLinkSource(link.url, link.sourceType),
  );
  const tooltip = forgeUrl ?? tooltipPath;
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      overflowWrap: "anywhere" as const,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered],
  );
  // Selection copy pastes a link Paseo recognized as the text the reply showed.
  const recognized = isRecognizedLink(link);
  const copyAnchorProps = useMemo(
    () =>
      recognized
        ? { ...anchorProps, [MARKDOWN_COPY_RECOGNIZED_LINK_ATTRIBUTE]: "true" }
        : anchorProps,
    [anchorProps, recognized],
  );
  const anchor = (
    <a
      {...copyAnchorProps}
      href={forgeUrl ?? anchorProps.href}
      style={anchorStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </a>
  );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
const styles = StyleSheet.create((theme) => ({
  sessionLinkAccent: {
    color: theme.colors.accentBright,
  },
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
export const WEB_EXTERNAL_RENDERERS: MarkdownRenderers = {
  codeBlock: WebCodeBlock,
  link: WebStandardLink,
};
