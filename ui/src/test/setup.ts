function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value));
    },
  };
}

function hasStorageMethods(value: unknown): value is Storage {
  const storage = value as Partial<Storage> | null | undefined;
  return Boolean(
    storage
    && typeof storage.getItem === "function"
    && typeof storage.setItem === "function"
    && typeof storage.removeItem === "function"
    && typeof storage.clear === "function",
  );
}

function readWindowLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return hasStorageMethods(window.localStorage) ? window.localStorage : null;
  } catch {
    return null;
  }
}

function installLocalStorageForJsdom() {
  // Most UI tests run in node; jsdom tests opt in per file with
  // `// @vitest-environment jsdom`.
  if (typeof window === "undefined") return;

  const storage = readWindowLocalStorage() ?? createMemoryStorage();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });

  if (!readWindowLocalStorage()) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
}

installLocalStorageForJsdom();
