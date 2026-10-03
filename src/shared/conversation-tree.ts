import type { PersistedMessage } from './types';

/**
 * Conversation-tree helpers.
 *
 * A session stores every message (including off-path branches) in a flat array.
 * Each message points at its `parentId`, so the displayed conversation is the
 * chain from a chosen leaf back to a root. These helpers are pure so they can be
 * shared by the chat window and the background worker.
 *
 * Stale data without `parentId`/`activeLeafId` is treated as one linear chain,
 * which keeps older sessions working unchanged.
 */

const ROOT_KEY = '__root__';

export function buildMessageIndex(messages: PersistedMessage[]): Map<string, PersistedMessage> {
  const index = new Map<string, PersistedMessage>();
  for (const message of messages) {
    index.set(message.id, message);
  }
  return index;
}

function parentKey(message: PersistedMessage): string {
  return message.parentId ?? ROOT_KEY;
}

/**
 * Resolves the visible conversation. When `activeLeafId` is missing or does not
 * resolve, the full array is returned unchanged (legacy behaviour).
 */
export function resolveActivePath(
  messages: PersistedMessage[],
  activeLeafId?: string | null
): PersistedMessage[] {
  if (messages.length === 0) {
    return [];
  }
  if (!activeLeafId) {
    return [...messages];
  }

  const index = buildMessageIndex(messages);
  const path: PersistedMessage[] = [];
  const seen = new Set<string>();
  let current = index.get(activeLeafId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    const parentId = current.parentId ?? null;
    if (!parentId) {
      break;
    }
    current = index.get(parentId);
  }

  if (path.length === 0) {
    return [...messages];
  }
  return path.reverse();
}

/** Siblings are messages with the same parent and role (the alternative versions). */
export function groupSiblings(message: PersistedMessage, messages: PersistedMessage[]): PersistedMessage[] {
  const key = parentKey(message);
  return messages.filter((item) => parentKey(item) === key && item.role === message.role);
}

export interface SiblingInfo {
  siblings: PersistedMessage[];
  index: number;
  total: number;
}

export function getSiblingInfo(message: PersistedMessage, messages: PersistedMessage[]): SiblingInfo {
  const siblings = groupSiblings(message, messages);
  const index = siblings.findIndex((item) => item.id === message.id);
  return {
    siblings,
    index: index < 0 ? 0 : index,
    total: siblings.length
  };
}

export function childrenOf(messageId: string, messages: PersistedMessage[]): PersistedMessage[] {
  return messages.filter((message) => message.parentId === messageId);
}

/**
 * Follows children from `startId` down to a leaf, always choosing the most
 * recently appended child, so switching versions lands on the newest branch.
 */
export function findLatestLeafUnder(
  startId: string | null | undefined,
  messages: PersistedMessage[]
): string | null {
  if (!startId) {
    return null;
  }
  const index = buildMessageIndex(messages);
  if (!index.has(startId)) {
    return startId;
  }

  let currentId = startId;
  const seen = new Set<string>();
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const children = childrenOf(currentId, messages);
    if (children.length === 0) {
      break;
    }
    currentId = children[children.length - 1].id;
  }
  return currentId;
}
