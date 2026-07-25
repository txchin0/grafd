// Browser file downloads. Native save dialogs are avoided app-wide (they are suppressed in
// several embedded browser hosts), so every export lands through a synthetic anchor click.

export function safeFileStem(label: string): string {
  return label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
