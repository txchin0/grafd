// Linting a whole .flow workspace, which is the only level at which cross-file questions can
// be answered: does an `expand` link land on a file that exists, does an `{Inner}` refinement
// name a node in that file, do the expansions form a cycle, and is every file reachable from
// the entrypoint.
//
// Every file is scanned once here and the scans are shared with the single-file rules, whose
// ExpansionLookup is upgraded to resolve external links against the workspace.

import { byLine, warning, type Diagnostic, type FileDiagnostics } from './flow-diagnostics.js';
import { parseExpandLink, resolveLinkPath } from './flow-format.js';
import { localExpansionLookup, type ExpansionLookup } from './flow-lint-semantics.js';
import { lintScannedFile } from './flow-lint.js';
import { allScannedNodes, findProperty, rootScope, scanFlow, type ScannedFile, type ScannedNode } from './flow-scan.js';
import { MANIFEST_FILE_NAME, defaultEntrypoint, type WorkspaceManifest } from './manifest.js';

export interface WorkspaceFile {
  path: string;
  text: string;
}

export interface WorkspaceLintInput {
  files: WorkspaceFile[];
  manifest?: WorkspaceManifest | null;
}

// §2.4: the format spec file is a root-level document every project carries, not something the
// graph links to, so it is never reported as unreachable.
const SPEC_FILE_NAME = 'SPEC.flow';

/** One expansion target: a whole file, or one local `graph:` block inside a file. */
interface ExpansionUnit {
  key: string;
  path: string;
  nodes: ScannedNode[];
}

export function lintWorkspace(input: WorkspaceLintInput): FileDiagnostics[] {
  const scans = new Map(input.files.map((file) => [file.path, scanFlow(file.text)]));
  const results = input.files.map((file) => ({
    path: file.path,
    diagnostics: lintScannedFile(scans.get(file.path)!, workspaceExpansionLookup(scans, file.path)),
  }));

  const byPath = new Map(results.map((result) => [result.path, result.diagnostics]));
  const report = (path: string, diagnostic: Diagnostic) => byPath.get(path)?.push(diagnostic);

  reportMissingHandlerFiles(scans, report);
  reportExpansionCycles(scans, report);
  const manifestDiagnostics = reportUnreachableFiles(scans, input.manifest ?? null, report);

  for (const result of results) result.diagnostics.sort(byLine);
  return manifestDiagnostics.length > 0
    ? [...results, { path: MANIFEST_FILE_NAME, diagnostics: manifestDiagnostics }]
    : results;
}

type Report = (path: string, diagnostic: Diagnostic) => void;

function workspaceExpansionLookup(scans: Map<string, ScannedFile>, path: string): ExpansionLookup {
  const resolveLocally = localExpansionLookup(scans.get(path)!);
  return (expandValue) => {
    const link = parseExpandLink(expandValue);
    if (!link) return resolveLocally(expandValue);
    const target = scans.get(resolveLinkPath(path, link.path));
    if (!target) return { kind: 'missing' };
    return { kind: 'resolved', entryNames: (rootScope(target)?.nodes ?? []).map((node) => node.name) };
  };
}

function onErrorHandlerProperties(scan: ScannedFile) {
  return [
    ...(scan.preamble?.fields ?? []),
    ...allScannedNodes(scan).flatMap((node) => node.properties),
  ].filter((property) => property.key === 'on_error');
}

// `on_error` may reference a handler graph in another file (spec §7.5); `expand` links are
// already checked by the semantic pass through the lookup above.
function reportMissingHandlerFiles(scans: Map<string, ScannedFile>, report: Report): void {
  for (const [path, scan] of scans) {
    for (const handler of onErrorHandlerProperties(scan)) {
      const link = parseExpandLink(handler.value);
      if (!link) continue;
      if (scans.has(resolveLinkPath(path, link.path))) continue;
      report(
        path,
        warning('on-error-file-not-found', handler.line, `No .flow file at "${link.path}", resolved relative to this file.`),
      );
    }
  }
}

function expansionUnits(scans: Map<string, ScannedFile>): Map<string, ExpansionUnit> {
  const units = new Map<string, ExpansionUnit>();
  for (const [path, scan] of scans) {
    for (const scope of scan.scopes) {
      const key = scope.name == null ? path : localUnitKey(path, scope.name);
      units.set(key, { key, path, nodes: scope.nodes });
    }
  }
  return units;
}

function localUnitKey(path: string, blockName: string): string {
  return `${path}#${blockName}`;
}

function expansionTargetKey(unit: ExpansionUnit, expandValue: string): string {
  const link = parseExpandLink(expandValue);
  return link ? resolveLinkPath(unit.path, link.path) : localUnitKey(unit.path, expandValue);
}

// A node whose expansion (directly or transitively) contains itself makes the graph infinitely
// deep; the editor unfolds expansions on demand, so it would never stop diving.
function reportExpansionCycles(scans: Map<string, ScannedFile>, report: Report): void {
  const units = expansionUnits(scans);
  const finished = new Set<string>();
  const onStack = new Set<string>();

  const visit = (key: string): void => {
    const unit = units.get(key);
    if (!unit || finished.has(key)) return;
    onStack.add(key);
    for (const node of unit.nodes) {
      const expand = findProperty(node, 'expand');
      if (!expand || expand.value === '') continue;
      const targetKey = expansionTargetKey(unit, expand.value);
      if (!units.has(targetKey)) continue;
      if (onStack.has(targetKey)) {
        report(
          unit.path,
          warning(
            'expansion-cycle',
            expand.line,
            `Expanding "${expand.value}" leads back to this graph, so the expansion never bottoms out.`,
          ),
        );
        continue;
      }
      visit(targetKey);
    }
    onStack.delete(key);
    finished.add(key);
  };

  for (const key of units.keys()) visit(key);
}

function reportUnreachableFiles(
  scans: Map<string, ScannedFile>,
  manifest: WorkspaceManifest | null,
  report: Report,
): Diagnostic[] {
  const paths = [...scans.keys()];
  const manifestDiagnostics: Diagnostic[] = [];
  if (manifest?.entrypoint && !scans.has(manifest.entrypoint)) {
    manifestDiagnostics.push(
      warning('manifest-entrypoint-missing', 1, `The workspace entrypoint "${manifest.entrypoint}" is not a file in this workspace.`),
    );
  }

  const declared = manifest?.entrypoint ?? null;
  const entrypoint = declared && scans.has(declared) ? declared : defaultEntrypoint(paths);
  if (!entrypoint) return manifestDiagnostics;

  const reached = filesReachableFrom(entrypoint, scans);
  for (const path of paths) {
    if (reached.has(path) || path === SPEC_FILE_NAME) continue;
    report(
      path,
      warning(
        'unreachable-flow-file',
        1,
        `No \`expand\` or \`on_error\` link reaches this file from the workspace entrypoint "${entrypoint}".`,
      ),
    );
  }
  return manifestDiagnostics;
}

function filesReachableFrom(entrypoint: string, scans: Map<string, ScannedFile>): Set<string> {
  const reached = new Set<string>();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const path = pending.shift()!;
    if (reached.has(path)) continue;
    reached.add(path);
    const scan = scans.get(path);
    if (!scan) continue;
    for (const linkedPath of linkedFlowPaths(scan, path)) pending.push(linkedPath);
  }
  return reached;
}

function linkedFlowPaths(scan: ScannedFile, sourcePath: string): string[] {
  const paths: string[] = [];
  for (const node of allScannedNodes(scan)) {
    const expandLink = parseExpandLink(findProperty(node, 'expand')?.value);
    if (expandLink) paths.push(resolveLinkPath(sourcePath, expandLink.path));
  }
  for (const handler of onErrorHandlerProperties(scan)) {
    const link = parseExpandLink(handler.value);
    if (link) paths.push(resolveLinkPath(sourcePath, link.path));
  }
  return paths;
}
