// A single reusable right-click menu, shared by every surface (canvas nodes/edges/empty
// space and the sidebar file tree). It is presentation-only: callers pass a list of items and
// a screen point; the menu reports which item was chosen through each item's onSelect. The
// element is body-level and fixed-positioned so it works over both the canvas and the sidebar.

const VIEWPORT_MARGIN = 8;
const BUTTON_MENU_GAP = 4;

export type MenuItem =
  | { label: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { separator: true };

// Where the menu's top-left corner goes. A menu anchored under a button must flip about the
// button rather than about the drop point, or flipping would lay the menu over the button
// that opened it — `flipY` is the y the menu's *bottom* edge takes when it has to flip up.
export interface MenuAnchor {
  x: number;
  y: number;
  flipY?: number;
}

export interface ContextMenu {
  open(items: MenuItem[], at: MenuAnchor): void;
  toggleFromButton(button: HTMLElement, items: MenuItem[], gap?: number): void;
  close(): void;
  isOpen(): boolean;
}

function isSeparator(item: MenuItem): item is { separator: true } {
  return 'separator' in item;
}

export function createContextMenu(): ContextMenu {
  const root = document.createElement('div');
  root.className = 'context-menu hidden';
  document.body.append(root);

  let open = false;
  let menuTrigger: HTMLElement | null = null;

  function close(): void {
    if (!open) return;
    open = false;
    menuTrigger = null;
    root.classList.add('hidden');
    root.replaceChildren();
    removeDismissListeners();
  }

  function dismissOnOutsidePointer(event: PointerEvent): void {
    const target = event.target as Node;
    // A button-anchored menu toggles on the trigger's click/keyboard activation; dismissing
    // on pointerdown would close before that event and break same-button toggle.
    if (menuTrigger?.contains(target)) return;
    if (!root.contains(target)) close();
  }
  function dismissOnEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  function addDismissListeners(): void {
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true);
    window.addEventListener('keydown', dismissOnEscape, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  }
  function removeDismissListeners(): void {
    document.removeEventListener('pointerdown', dismissOnOutsidePointer, true);
    window.removeEventListener('keydown', dismissOnEscape, true);
    window.removeEventListener('wheel', close, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
  }

  function renderItems(items: MenuItem[]): void {
    const elements = items.map((item) => {
      if (isSeparator(item)) {
        const rule = document.createElement('div');
        rule.className = 'context-menu-separator';
        return rule;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'context-menu-item';
      button.textContent = item.label;
      button.classList.toggle('danger', Boolean(item.danger));
      if (item.disabled) {
        button.classList.add('disabled');
      } else {
        button.addEventListener('click', () => {
          close();
          item.onSelect();
        });
      }
      return button;
    });
    root.replaceChildren(...elements);
  }

  // Placed at the click point, then nudged back inside the viewport if it would overflow the
  // right or bottom edge (mirrors positionBesideRect's clamp, against the window here).
  function position(at: MenuAnchor): void {
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    let left = at.x;
    let top = at.y;
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) left = at.x - width;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = (at.flipY ?? at.y) - height;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN));
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - height - VIEWPORT_MARGIN));
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  function show(items: MenuItem[], at: MenuAnchor): void {
    close();
    if (items.length === 0) return;
    renderItems(items);
    root.classList.remove('hidden');
    open = true;
    position(at);
    addDismissListeners();
  }

  function openFromButton(button: HTMLElement, items: MenuItem[], gap: number): void {
    const rect = button.getBoundingClientRect();
    menuTrigger = button;
    show(items, {
      x: rect.left,
      y: rect.bottom + gap,
      flipY: rect.top - gap,
    });
  }

  return {
    open(items, at) {
      menuTrigger = null;
      show(items, at);
    },
    toggleFromButton(button, items, gap = BUTTON_MENU_GAP) {
      if (open && menuTrigger === button) {
        close();
        return;
      }
      openFromButton(button, items, gap);
    },
    close,
    isOpen: () => open,
  };
}
