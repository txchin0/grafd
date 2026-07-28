// Choosing paths for .flow files: normalising what the user typed, and picking a free name
// beside the ones already in the workspace. Pure functions over the workspace's flat portable
// paths — no DOM, no workspace I/O.
//
// Every "is this name taken" check is case-insensitive. The file systems Graf writes to are
// commonly case-insensitive, so a candidate differing only in case would clobber the file it
// was meant to sit beside rather than becoming a new one.

const FLOW_EXTENSION = '.flow';

export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function findExistingFile(files: string[], name: string): string | undefined {
  const lowered = name.toLowerCase();
  return files.find((file) => file.toLowerCase() === lowered);
}

// Accepts what the user typed in the new-file box: backslashes become separators, and the
// extension is implied. Returns '' for a name that is only whitespace.
export function normalizeFlowPath(rawName: string): string {
  const name = rawName.trim().replace(/\\/g, '/');
  if (!name) return '';
  return name.endsWith(FLOW_EXTENSION) ? name : `${name}${FLOW_EXTENSION}`;
}

export function nextUntitledFlowName(files: string[]): string {
  for (let index = files.length + 1; ; index += 1) {
    const candidate = `untitled-${index}${FLOW_EXTENSION}`;
    if (!findExistingFile(files, candidate)) return candidate;
  }
}

export function copyFlowPath(files: string[], path: string): string {
  const base = path.replace(/\.flow$/, '');
  let candidate = `${base} copy${FLOW_EXTENSION}`;
  let counter = 2;
  while (findExistingFile(files, candidate)) {
    candidate = `${base} copy ${counter}${FLOW_EXTENSION}`;
    counter += 1;
  }
  return candidate;
}

export function kebabFileName(blockName: string): string {
  const slug = blockName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'subgraph'}${FLOW_EXTENSION}`;
}

// A subgraph extracted out of a node lands beside the file that owns it, so `expand` links
// inside the moved nodes keep resolving and the parent's new link is a bare file name.
export function extractedFlowPath(files: string[], ownerPath: string, graphName: string): string {
  const folder = folderOf(ownerPath);
  const name = kebabFileName(graphName);
  let candidate = join(folder, name);
  let counter = 2;
  while (findExistingFile(files, candidate)) {
    candidate = join(folder, name.replace(/\.flow$/, `-${counter}${FLOW_EXTENSION}`));
    counter += 1;
  }
  return candidate;
}
