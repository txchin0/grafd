// Free-form properties on a context block — the same shape a node carries, but on ContextBlock.

import type { ContextBlock } from '../../shared/flow-format.js';

export function getBlockProp(block: ContextBlock, key: string): string | null {
  return block.props.find((prop) => prop.key === key)?.value ?? null;
}

export function setBlockProp(block: ContextBlock, key: string, value: string | null): void {
  if (value == null || value === '') {
    block.props = block.props.filter((prop) => prop.key !== key);
    return;
  }
  const existing = block.props.find((prop) => prop.key === key);
  if (existing) existing.value = value;
  else block.props.push({ key, value });
}
