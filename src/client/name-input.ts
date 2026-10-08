// A text field that edits a name. The characters no name can hold (withoutReservedNameCharacters)
// are refused as they are typed or pasted, so what the field shows is what will be saved.

import { withoutReservedNameCharacters } from '../shared/flow-format.js';

export function refuseReservedNameCharacters(input: HTMLInputElement): void {
  input.addEventListener('input', () => {
    const typed = input.value;
    const kept = withoutReservedNameCharacters(typed);
    if (kept === typed) return;
    const caret = Math.max(0, (input.selectionStart ?? typed.length) - (typed.length - kept.length));
    input.value = kept;
    input.setSelectionRange(caret, caret);
  });
}
