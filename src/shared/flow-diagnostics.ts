// The diagnostic vocabulary shared by every .flow lint rule.
//
// `error` means the file is corrupt as far as the parser is concerned: content is dropped or
// mangled, and because the editor round-trips every file it opens (parse → serialize → write),
// an error left unfixed can destroy content on the next save. `warning` means the file parses
// cleanly but says something that is probably not what the author meant.

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  rule: string;
  severity: DiagnosticSeverity;
  line: number;
  message: string;
}

export interface FileDiagnostics {
  path: string;
  diagnostics: Diagnostic[];
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
}

export function error(rule: string, line: number, message: string): Diagnostic {
  return { rule, severity: 'error', line, message };
}

export function warning(rule: string, line: number, message: string): Diagnostic {
  return { rule, severity: 'warning', line, message };
}

export function byLine(first: Diagnostic, second: Diagnostic): number {
  return first.line - second.line || first.rule.localeCompare(second.rule);
}

export function countDiagnostics(files: FileDiagnostics[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { errors: 0, warnings: 0 };
  for (const file of files) {
    for (const diagnostic of file.diagnostics) {
      if (diagnostic.severity === 'error') counts.errors += 1;
      else counts.warnings += 1;
    }
  }
  return counts;
}
