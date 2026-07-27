// The .flow linter's single-file entry point.
//
// parseFlow accepts anything and reports nothing — it is built to keep a half-written canvas
// loading, not to judge a file. This linter is the other half of that contract: it says what
// the parser will quietly drop, mangle, or fail to resolve, so an agent that has just edited a
// .flow file can find out before the editor round-trips the damage to disk.

import { byLine, type Diagnostic } from './flow-diagnostics.js';
import { lintSemantics, localExpansionLookup, type ExpansionLookup } from './flow-lint-semantics.js';
import { lintSyntax } from './flow-lint-syntax.js';
import { scanFlow, type ScannedFile } from './flow-scan.js';

export function lintFlowFile(text: string): Diagnostic[] {
  const scan = scanFlow(text);
  return lintScannedFile(scan, localExpansionLookup(scan));
}

/** Lints an already-scanned file, so the workspace pass can scan each file only once. */
export function lintScannedFile(scan: ScannedFile, lookup: ExpansionLookup): Diagnostic[] {
  return [...lintSyntax(scan), ...lintSemantics(scan, lookup)].sort(byLine);
}
