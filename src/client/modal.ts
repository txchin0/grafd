// The scrim-and-panel shell every full-screen dialog shares: the export dialog and the
// preferences dialog differ only in what their panel contains.

export interface Modal {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createModal(modalId: string, panelId: string): Modal {
  const scrim = document.getElementById(modalId) as HTMLDivElement;
  const panel = document.getElementById(panelId) as HTMLDivElement;

  function close(): void {
    scrim.classList.add('hidden');
  }

  // Clicks inside the panel must not reach the scrim's dismiss handler.
  panel.addEventListener('click', (event) => event.stopPropagation());
  scrim.addEventListener('click', close);

  return {
    open: () => scrim.classList.remove('hidden'),
    close,
    isOpen: () => !scrim.classList.contains('hidden'),
  };
}
