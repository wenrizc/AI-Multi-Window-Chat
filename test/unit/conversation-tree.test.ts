import { describe, expect, it } from 'vitest';
import {
  childrenOf,
  findLatestLeafUnder,
  getSiblingInfo,
  groupSiblings,
  resolveActivePath
} from '../../src/shared/conversation-tree';
import type { PersistedMessage } from '../../src/shared/types';
import { createPersistedMessage } from '../helpers/factories';

function message(id: string, parentId: string | null, content = id): PersistedMessage {
  return createPersistedMessage({ id, parentId, content, role: 'assistant' });
}

/**
 *  u1 -> a1 -> u2 -> a2
 *               \-> a2b
 *  u1 -> a1b
 */
function tree(): PersistedMessage[] {
  return [
    message('u1', null),
    message('a1', 'u1'),
    message('u2', 'a1'),
    message('a2', 'u2'),
    message('a2b', 'u2'),
    message('a1b', 'u1')
  ];
}

describe('resolveActivePath', () => {
  it('returns the full array when no active leaf is provided', () => {
    const messages = tree();
    expect(resolveActivePath(messages, null).map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'a2b',
      'a1b'
    ]);
  });

  it('walks parent links from the leaf and drops off-path siblings', () => {
    expect(resolveActivePath(tree(), 'a2').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('supports switching to another branch', () => {
    expect(resolveActivePath(tree(), 'a1b').map((m) => m.id)).toEqual(['u1', 'a1b']);
    expect(resolveActivePath(tree(), 'a2b').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2b']);
  });

  it('falls back to the full array when the leaf is unknown', () => {
    const messages = tree();
    expect(resolveActivePath(messages, 'missing')).toEqual(messages);
  });

  it('is cycle-safe', () => {
    const messages = [
      createPersistedMessage({ id: 'a', parentId: 'b' }),
      createPersistedMessage({ id: 'b', parentId: 'a' })
    ];
    expect(resolveActivePath(messages, 'a').map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('sibling helpers', () => {
  it('groups messages that share a parent and role', () => {
    expect(groupSiblings(tree()[3], tree()).map((m) => m.id)).toEqual(['a2', 'a2b']);
    expect(getSiblingInfo(tree()[3], tree())).toMatchObject({ index: 0, total: 2 });
    expect(getSiblingInfo(tree()[4], tree())).toMatchObject({ index: 1, total: 2 });
  });

  it('treats root messages as a group', () => {
    const messages = [message('r1', null), message('r2', null)];
    expect(getSiblingInfo(messages[1], messages)).toMatchObject({ index: 1, total: 2 });
  });
});

describe('findLatestLeafUnder', () => {
  it('follows the most recently appended child down to a leaf', () => {
    expect(findLatestLeafUnder('a1', tree())).toBe('a2b');
    expect(findLatestLeafUnder('u2', tree())).toBe('a2b');
  });

  it('returns the start id for leaves and unknown ids', () => {
    expect(findLatestLeafUnder('a1b', tree())).toBe('a1b');
    expect(findLatestLeafUnder('ghost', tree())).toBe('ghost');
    expect(findLatestLeafUnder(null, tree())).toBeNull();
  });
});

describe('childrenOf', () => {
  it('lists direct children', () => {
    expect(childrenOf('u1', tree()).map((m) => m.id)).toEqual(['a1', 'a1b']);
    expect(childrenOf('missing', tree())).toEqual([]);
  });
});
