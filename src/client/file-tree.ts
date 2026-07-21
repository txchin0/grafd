// Folds the workspace's flat portable paths ("auth/login.flow") into the folder tree the
// sidebar renders. Pure data — rendering, collapse state, and interaction live in main.ts.

export interface TreeFile {
  name: string;
  path: string;
}

export interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: TreeFile[];
}

export function buildFileTree(paths: string[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [] };
  for (const path of [...paths].sort()) {
    const segments = path.split('/');
    const fileName = segments.pop()!;
    let folder = root;
    let folderPath = '';
    for (const segment of segments) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      folder = childFolder(folder, segment, folderPath);
    }
    folder.files.push({ name: fileName, path });
  }
  return root;
}

function childFolder(parent: TreeFolder, name: string, path: string): TreeFolder {
  const existing = parent.folders.find((folder) => folder.name === name);
  if (existing) return existing;
  const created: TreeFolder = { name, path, folders: [], files: [] };
  parent.folders.push(created);
  return created;
}
