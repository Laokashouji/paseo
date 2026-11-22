/** Native inputs retain their platform clipboard handling. */
export function resolveLinkedClipboardMarkdown(
  _clipboard: Pick<DataTransfer, "getData"> | null,
): string | null {
  return null;
}

/** Native inputs retain their platform clipboard handling. */
export function pasteLinkedClipboardText(
  _input: HTMLElement,
  _clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  return false;
}
