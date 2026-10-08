// The editor's keyboard commands as data: every command a shortcut runs, and the keys bound to
// it. The page's keyboard handler (main.ts) and the random test sessions both go through this
// list, so a shortcut added here is one the sessions press too. What each command does lives in
// the editor core (`runCommand`); shortcuts that only touch the page — the sidebar, the tool
// keys, the help overlay — stay in main.ts.

export const EDITOR_COMMANDS = [
  'undo',
  'redo',
  'select-all',
  'copy',
  'cut',
  'paste',
  'duplicate',
  'group',
  'ungroup',
  'delete',
  'fit',
  'zoom-in',
  'zoom-out',
  'escape',
] as const;
export type EditorCommand = (typeof EDITOR_COMMANDS)[number];

// `key` is compared lowercased. A modifier left out matches either way.
interface KeyBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  command: EditorCommand;
}

const KEY_BINDINGS: readonly KeyBinding[] = [
  { key: 'z', ctrl: true, shift: false, command: 'undo' },
  { key: 'z', ctrl: true, shift: true, command: 'redo' },
  { key: 'y', ctrl: true, command: 'redo' },
  { key: 'a', ctrl: true, command: 'select-all' },
  { key: 'c', ctrl: true, command: 'copy' },
  { key: 'x', ctrl: true, command: 'cut' },
  { key: 'v', ctrl: true, command: 'paste' },
  { key: 'd', ctrl: true, command: 'duplicate' },
  { key: 'g', ctrl: true, shift: false, command: 'group' },
  { key: 'g', ctrl: true, shift: true, command: 'ungroup' },
  { key: 'delete', command: 'delete' },
  { key: 'backspace', command: 'delete' },
  { key: '0', ctrl: true, command: 'fit' },
  { key: '=', ctrl: true, command: 'zoom-in' },
  { key: '+', ctrl: true, command: 'zoom-in' },
  { key: '-', ctrl: true, command: 'zoom-out' },
  { key: 'escape', command: 'escape' },
];

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

// Command on macOS is Ctrl everywhere else.
export function commandForKey(press: KeyPress): EditorCommand | null {
  const key = press.key.toLowerCase();
  const ctrl = press.ctrlKey || press.metaKey;
  const binding = KEY_BINDINGS.find((candidate) => candidate.key === key
    && (candidate.ctrl === undefined || candidate.ctrl === ctrl)
    && (candidate.shift === undefined || candidate.shift === press.shiftKey));
  return binding?.command ?? null;
}
