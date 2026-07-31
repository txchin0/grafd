// Linting a whole .flow workspace, which is the only level at which cross-file questions can
// be answered: does an `expand` link land on a file that exists, does an `{Inner}` refinement
// name a node in that file, do the expansions form a cycle, and is every file reachable from
// the entrypoint.
//
// Every file is scanned once here and the scans are shared with the single-file rules, whose
// ExpansionLookup is upgraded to resolve external links against the workspace.

import { byLine, warning, type Diagnostic, type FileDiagnostics } from './flow-diagnostics.js';
import { parseExpandLink, parseListValue, resolveLinkPath } from './flow-format.js';
import {
  inheritedContextNames,
  localExpansionLookup,
  readableContextsByNode,
  type ExpansionLookup,
} from './flow-lint-semantics.js';
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
  reportOrphanedInheritance(scans, report);
  reportMissingInheritance(scans, report);
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

/** A node in one file whose `expand` link resolves to another file. */
interface ExpansionHost {
  path: string;
  node: ScannedNode;
  /** Whether it is declared at column 0, the only place a context block can name it. */
  topLevel: boolean;
}

// `inherits` is auto-generated from membership in the parent (spec §8.4): a provider reaches only
// the expansions of the nodes its block lists. An entry naming something the host node cannot read
// is stale — the parent's region no longer covers it — and the editor will not regenerate it.
function reportOrphanedInheritance(scans: Map<string, ScannedFile>, report: Report): void {
  const hostsByTargetPath = expansionHostsByTargetPath(scans);
  for (const [path, scan] of scans) {
    const hosts = hostsByTargetPath.get(path) ?? [];
    // A file nothing expands has no parent to check against; unreachable-flow-file covers it.
    if (hosts.length === 0) continue;
    for (const field of (scan.preamble?.fields ?? []).filter((entry) => entry.key === 'inherits')) {
      for (const name of parseListValue(field.value)) {
        if (hosts.some((host) => hostReadsContext(scans, host, name))) continue;
        report(
          path,
          warning(
            'inherits-without-parent-membership',
            field.line,
            `Nothing that expands this file can read "${name}": no \`context: ${name}\` block lists the node expanding it. Drag that node into the region, or drop this entry.`,
          ),
        );
      }
    }
  }
}

// The other direction, and the one no user can see: `inherits` is auto-generated, so a provider
// that failed to reach an expansion leaves nothing behind to notice. A node passes everything it
// reads into its expansion, and an inherited provider is graph-wide in the file that receives it
// (spec §8.4) — so this propagates to any depth without a walk, because each file is measured
// against the `inherits` its own children actually carry. A break is therefore reported once, at
// the level where it happens, instead of cascading down the subtree beneath it.
function reportMissingInheritance(scans: Map<string, ScannedFile>, report: Report): void {
  for (const [path, scan] of scans) {
    const readable = readableContextsByNode(scan);
    for (const node of allScannedNodes(scan)) {
      const expand = findProperty(node, 'expand');
      const link = parseExpandLink(expand?.value);
      // A local `graph:` block has no preamble, so there is nowhere for `inherits` to live; those
      // nodes read through their host instead, which readableContextsByNode already resolves.
      if (!expand || !link) continue;
      const target = scans.get(resolveLinkPath(path, link.path));
      if (!target) continue;
      const alreadyInherited = new Set(inheritedContextNames(target));
      for (const name of readable.get(node) ?? []) {
        if (alreadyInherited.has(name)) continue;
        report(
          path,
          warning(
            'expansion-missing-inherits',
            expand.line,
            `"${node.name}" can read context "${name}", so its expansion can too, but "${link.path}" does not inherit it. \`inherits\` is auto-generated: reading that file alone, an agent never learns "${name}" is available.`,
          ),
        );
      }
    }
  }
}

function hostReadsContext(scans: Map<string, ScannedFile>, host: ExpansionHost, name: string): boolean {
  const parent = scans.get(host.path);
  // A host inside a `graph:` block reads through the node expanding that block, which this walk
  // does not follow; treat it as answered rather than guess.
  if (!parent || !host.topLevel) return true;
  const listedInBlock = parent.contexts.some(
    (block) => block.name === name && block.members.some((member) => member.name === host.node.name),
  );
  return listedInBlock || inheritedContextNames(parent).includes(name);
}

function expansionHostsByTargetPath(scans: Map<string, ScannedFile>): Map<string, ExpansionHost[]> {
  const hostsByTargetPath = new Map<string, ExpansionHost[]>();
  for (const [path, scan] of scans) {
    const topLevelNodes = new Set(rootScope(scan)?.nodes ?? []);
    for (const node of allScannedNodes(scan)) {
      const link = parseExpandLink(findProperty(node, 'expand')?.value);
      if (!link) continue;
      const targetPath = resolveLinkPath(path, link.path);
      const hosts = hostsByTargetPath.get(targetPath) ?? [];
      hosts.push({ path, node, topLevel: topLevelNodes.has(node) });
      hostsByTargetPath.set(targetPath, hosts);
    }
  }
  return hostsByTargetPath;
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
