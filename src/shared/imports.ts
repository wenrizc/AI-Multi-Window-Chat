import type { PromptConfig, ProviderConfig } from './types';

type Identified = {
  id: string;
};

type MergeResult<T> = {
  items: T[];
  addedCount: number;
  updatedCount: number;
};

function mergeById<T extends Identified>(existing: T[], incoming: T[]): MergeResult<T> {
  const items = [...existing];
  const indexById = new Map(items.map((item, index) => [item.id, index]));
  let addedCount = 0;
  let updatedCount = 0;

  incoming.forEach((item) => {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, items.length);
      items.push(item);
      addedCount += 1;
      return;
    }

    items[existingIndex] = item;
    updatedCount += 1;
  });

  return {
    items,
    addedCount,
    updatedCount
  };
}

export function mergeProvidersForImport(existing: ProviderConfig[], incoming: ProviderConfig[]) {
  const result = mergeById(existing, incoming);
  return {
    providers: result.items,
    addedCount: result.addedCount,
    updatedCount: result.updatedCount
  };
}

export function mergePromptsForImport(existing: PromptConfig[], incoming: PromptConfig[]) {
  const result = mergeById(existing, incoming);
  return {
    prompts: result.items,
    addedCount: result.addedCount,
    updatedCount: result.updatedCount
  };
}
