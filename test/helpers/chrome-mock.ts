/**
 * Environment-agnostic `chrome.*` mock shared by node (unit/integration) and
 * browser (component) test setups.
 *
 * It deliberately mirrors the small slice of the extension API surface this
 * project actually touches: `storage.local`, `runtime` (messaging, ports,
 * manifest, getURL), `tabs` and `i18n`. Node-only concerns such as reading the
 * real `_locales` files live in `test/setup/node.ts`.
 */

export type LocalizedMessage = {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
};

export type MessagesMap = Record<string, LocalizedMessage>;

type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => unknown;

export type PortMock = {
  name: string;
  posted: unknown[];
  onMessage: {
    addListener: (listener: (message: unknown) => void) => void;
    removeListener: (listener: (message: unknown) => void) => void;
  };
  onDisconnect: {
    addListener: (listener: (port: PortMock) => void) => void;
    removeListener: (listener: (port: PortMock) => void) => void;
  };
  postMessage: (message: unknown) => void;
  /** Test helper: push a message into the app side of the port. */
  emit: (message: unknown) => void;
  /** Test helper: fire `onDisconnect` listeners. */
  disconnect: () => void;
};

export type ChromeMock = {
  chrome: Record<string, unknown>;
  state: ChromeMockState;
};

export type ChromeMockState = {
  storage: Record<string, unknown>;
  ports: PortMock[];
  runtimeMessages: unknown[];
  tabMessages: Array<{ tabId: number; message: unknown }>;
  reset: () => void;
  /** Seed `chrome.storage.local` (e.g. with a `RootStore`). */
  seedStorage: (items: Record<string, unknown>) => void;
  /** Replace the `runtime.sendMessage` response handler. */
  setRuntimeMessageHandler: (handler: (message: unknown) => unknown) => void;
  /** Remove all runtime/onConnect listeners (useful between re-imports). */
  resetListeners: () => void;
  /** Dispatch a message to `runtime.onMessage` listeners (content scripts / background). */
  dispatchRuntimeMessage: (message: unknown, sender?: unknown) => Promise<unknown>;
  /** Create and announce a port, running `runtime.onConnect` listeners. */
  openPort: (name: string) => PortMock;
  /** Run the most recently registered `onMessage` listener registered on a port. */
  emitPort: (port: PortMock, message: unknown) => void;
  /** The last message posted through `tabs.sendMessage`. */
  lastTabMessage: () => { tabId: number; message: unknown } | null;
  /** The latest port created via `runtime.connect`. */
  lastPort: () => PortMock | null;
};

function substitute(message: string, substitutions: Array<string | number>): string {
  return message.replace(/\$(\d+)/g, (_match, index: string) => {
    const value = substitutions[Number(index) - 1];
    return value === undefined ? '' : String(value);
  }).replace(/\$\$/g, '$');
}

export function createChromeMock(options: { messages?: MessagesMap } = {}): ChromeMock {
  const messages = options.messages ?? {};

  let storage: Record<string, unknown> = {};
  let ports: PortMock[] = [];
  let runtimeMessages: unknown[] = [];
  let tabMessages: Array<{ tabId: number; message: unknown }> = [];
  let connectListeners: Array<(port: PortMock) => void> = [];
  let messageListeners: RuntimeMessageListener[] = [];
  let runtimeMessageHandler: (message: unknown) => unknown = () => ({ success: true });
  let nextTabId = 1;

  function getMessage(key: string, substitutions?: string | number | Array<string | number>): string {
    const entry = messages[key];
    if (!entry) {
      return '';
    }
    const values: Array<string | number> = Array.isArray(substitutions)
      ? substitutions
      : substitutions === undefined || substitutions === null
        ? []
        : [substitutions];

    let template = entry.message;
    if (entry.placeholders) {
      for (const [name, definition] of Object.entries(entry.placeholders)) {
        const content = substitute(definition.content, values);
        template = template.split(`$${name}$`).join(content);
      }
    }
    return substitute(template, values);
  }

  function createPort(name: string): PortMock {
    const messageListenersForPort: Array<(message: unknown) => void> = [];
    const disconnectListeners: Array<(port: PortMock) => void> = [];
    const port: PortMock = {
      name,
      posted: [],
      onMessage: {
        addListener: (listener) => {
          messageListenersForPort.push(listener);
        },
        removeListener: (listener) => {
          const index = messageListenersForPort.indexOf(listener);
          if (index >= 0) {
            messageListenersForPort.splice(index, 1);
          }
        }
      },
      onDisconnect: {
        addListener: (listener) => {
          disconnectListeners.push(listener);
        },
        removeListener: (listener) => {
          const index = disconnectListeners.indexOf(listener);
          if (index >= 0) {
            disconnectListeners.splice(index, 1);
          }
        }
      },
      postMessage: (message) => {
        port.posted.push(message);
      },
      emit: (message) => {
        for (const listener of [...messageListenersForPort]) {
          listener(message);
        }
      },
      disconnect: () => {
        for (const listener of [...disconnectListeners]) {
          listener(port);
        }
      }
    };
    return port;
  }

  const chrome = {
    i18n: {
      getMessage,
      getUILanguage: () => 'en',
      getAcceptLanguages: (callback?: (languages: string[]) => void) => {
        const languages = ['en'];
        callback?.(languages);
        return Promise.resolve(languages);
      },
      detectLanguage: (
        _text: string,
        callback?: (result: { isReliable: boolean; languages: Array<{ language: string; percentage: number }> }) => void
      ) => {
        const result = { isReliable: true, languages: [{ language: 'en', percentage: 100 }] };
        callback?.(result);
        return Promise.resolve(result);
      }
    },
    storage: {
      local: {
        get: async (keys?: unknown) => {
          if (keys === undefined || keys === null) {
            return { ...storage };
          }
          if (typeof keys === 'string') {
            return keys in storage ? { [keys]: storage[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const result: Record<string, unknown> = {};
            for (const key of keys) {
              if (typeof key === 'string' && key in storage) {
                result[key] = storage[key];
              }
            }
            return result;
          }
          if (typeof keys === 'object') {
            const result: Record<string, unknown> = { ...(keys as Record<string, unknown>) };
            for (const key of Object.keys(keys as Record<string, unknown>)) {
              if (key in storage) {
                result[key] = storage[key];
              }
            }
            return result;
          }
          return {};
        },
        set: async (items: Record<string, unknown>) => {
          storage = { ...storage, ...items };
        },
        remove: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) {
            delete storage[key];
          }
        },
        clear: async () => {
          storage = {};
        },
        onChanged: {
          addListener: () => undefined,
          removeListener: () => undefined
        }
      }
    },
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '2.0.0' }),
      getURL: (path = '') => `chrome-extension://test-extension-id/${String(path).replace(/^\//, '')}`,
      connect: (info?: { name?: string }) => {
        const port = createPort(info?.name ?? '');
        ports.push(port);
        for (const listener of [...connectListeners]) {
          listener(port);
        }
        return port;
      },
      sendMessage: async (message: unknown) => {
        runtimeMessages.push(message);
        return runtimeMessageHandler(message);
      },
      onConnect: {
        addListener: (listener: (port: PortMock) => void) => {
          connectListeners.push(listener);
        },
        removeListener: (listener: (port: PortMock) => void) => {
          const index = connectListeners.indexOf(listener);
          if (index >= 0) {
            connectListeners.splice(index, 1);
          }
        }
      },
      onMessage: {
        addListener: (listener: RuntimeMessageListener) => {
          messageListeners.push(listener);
        },
        removeListener: (listener: RuntimeMessageListener) => {
          const index = messageListeners.indexOf(listener);
          if (index >= 0) {
            messageListeners.splice(index, 1);
          }
        }
      },
      lastError: undefined
    },
    tabs: {
      query: async () => [{ id: nextTabId, active: true, currentWindow: true }],
      sendMessage: async (tabId: number, message: unknown) => {
        tabMessages.push({ tabId, message });
        return {};
      },
      create: async () => ({ id: nextTabId }),
      getCurrent: async () => ({ id: nextTabId })
    },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined
    }
  };

  const state: ChromeMockState = {
    get storage() {
      return storage;
    },
    get ports() {
      return ports;
    },
    get runtimeMessages() {
      return runtimeMessages;
    },
    get tabMessages() {
      return tabMessages;
    },
    reset: () => {
      storage = {};
      ports = [];
      runtimeMessages = [];
      tabMessages = [];
      runtimeMessageHandler = () => ({ success: true });
      nextTabId = 1;
    },
    resetListeners: () => {
      connectListeners = [];
      messageListeners = [];
    },
    seedStorage: (items) => {
      storage = { ...storage, ...items };
    },
    setRuntimeMessageHandler: (handler) => {
      runtimeMessageHandler = handler;
    },
    dispatchRuntimeMessage: async (message, sender) => {
      let response: unknown;
      let responded = false;
      const sendResponse = (value: unknown) => {
        response = value;
        responded = true;
      };
      for (const listener of [...messageListeners]) {
        const result = listener(message, sender ?? { id: 'test-extension-id' }, sendResponse);
        if (result === true) {
          // Listener will respond asynchronously once its work resolves.
          const start = Date.now();
          while (!responded && Date.now() - start < 5000) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      }
      return responded ? response : undefined;
    },
    openPort: (name) => createPort(name),
    emitPort: (port, message) => {
      port.emit(message);
    },
    lastTabMessage: () => (tabMessages.length > 0 ? tabMessages[tabMessages.length - 1] : null),
    lastPort: () => (ports.length > 0 ? ports[ports.length - 1] : null)
  };

  return { chrome, state };
}

const GLOBAL_STATE_KEY = '__chromeMockState';

/** Install a chrome mock on `globalThis` and return its state object. */
export function installChrome(options: { messages?: MessagesMap } = {}): ChromeMockState {
  const mock = createChromeMock(options);
  (globalThis as Record<string, unknown>).chrome = mock.chrome;
  (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] = mock.state;
  return mock.state;
}

/** Access the chrome mock installed by the active setup file. */
export function getChromeState(): ChromeMockState {
  const state = (globalThis as Record<string, unknown>)[GLOBAL_STATE_KEY] as ChromeMockState | undefined;
  if (!state) {
    throw new Error('chrome mock is not installed; is a setup file registered?');
  }
  return state;
}
