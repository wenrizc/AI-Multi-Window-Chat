import fs from 'node:fs';
import path from 'node:path';
import { beforeEach } from 'vitest';
import { installChrome, type MessagesMap } from '../helpers/chrome-mock';

// Use the real English locale so integration tests exercise the shipped
// placeholder/substitution rules instead of hand-written stubs.
const messages = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), '_locales/en/messages.json'), 'utf8')
) as MessagesMap;

const state = installChrome({ messages });

beforeEach(() => {
  state.reset();
});
