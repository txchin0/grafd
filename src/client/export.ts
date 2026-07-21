// Workspace export: bundles every .flow file, the workspace manifest, and SAVE-GUIDE.md
// (the how-to-read-this-format guide for AI agents) into a downloadable .zip. The guide is
// fetched from the app's own static assets so the export always matches the deployed
// editor's format implementation.

import { MANIFEST_FILE_NAME, serializeManifest, type WorkspaceManifest } from '../shared/manifest.js';
import { createZipArchive, type ZipEntry } from './zip.js';

export const SAVE_GUIDE_FILE_NAME = 'SAVE-GUIDE.md';

export interface ExportSource {
  files: string[];
  readFile(path: string): Promise<string | null>;
  manifest: WorkspaceManifest;
  workspaceLabel: string;
}

export async function exportWorkspaceAsZip(source: ExportSource): Promise<void> {
  const entries: ZipEntry[] = [];
  for (const path of source.files) {
    const text = await source.readFile(path);
    if (text != null) entries.push({ path, text });
  }
  entries.push({ path: MANIFEST_FILE_NAME, text: serializeManifest(source.manifest) });
  entries.push({ path: SAVE_GUIDE_FILE_NAME, text: await fetchSaveGuide() });

  const archive = createZipArchive(entries);
  triggerDownload(archive, archiveName(source.workspaceLabel));
}

async function fetchSaveGuide(): Promise<string> {
  const response = await fetch(`./${SAVE_GUIDE_FILE_NAME}`);
  if (!response.ok) throw new Error(`SAVE-GUIDE.md is not available (HTTP ${response.status})`);
  return response.text();
}

function archiveName(workspaceLabel: string): string {
  const safeLabel = workspaceLabel.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safeLabel || 'graf-workspace'}.flow.zip`;
}

function triggerDownload(archive: Uint8Array, fileName: string): void {
  const blob = new Blob([archive as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
