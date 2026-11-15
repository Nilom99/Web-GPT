import type { Conversation, ThemeMode } from '../types/chat';

const DB_NAME = 'webgpt-db';
const DB_VERSION = 1;
const STORE_NAME = 'conversations';
const THEME_KEY = 'webgpt-theme';
const ACTIVE_CONV_KEY = 'webgpt-active-conversation';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

export async function loadAllConversations(): Promise<Conversation[]> {
  try {
    const db = await openDatabase();
    return await new Promise<Conversation[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result as Conversation[]) || [];
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(conversation);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to save conversation'));
  });
}

export async function deleteConversationById(id: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to delete conversation'));
  });
}

export function deriveConversationTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  return cleaned.length > 48 ? `${cleaned.slice(0, 48).trimEnd()}...` : cleaned;
}

export function loadThemePreference(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    // ignore storage access errors
  }
  return 'light';
}

export function saveThemePreference(theme: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

export function loadActiveConversationId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CONV_KEY);
  } catch {
    return null;
  }
}

export function saveActiveConversationId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_CONV_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_CONV_KEY);
    }
  } catch {
    // ignore
  }
}

export function formatConversationAsTxt(conversation: Conversation): string {
  const header = [
    'WebGPT — Conversation Export',
    'Created by Abdus Nilom',
    `Title: ${conversation.title}`,
    `Updated: ${new Date(conversation.updatedAt).toISOString()}`,
    '----------------------------------------',
    '',
  ].join('\n');

  const body = conversation.messages
    .map((msg) => {
      const speaker = msg.role === 'user' ? 'You' : 'WebGPT';
      const time = new Date(msg.createdAt).toLocaleString();
      return `[${speaker}] (${time})\n${msg.content}\n`;
    })
    .join('\n');

  return header + body;
}

export function formatConversationAsJson(conversation: Conversation): string {
  return JSON.stringify(
    {
      product: 'WebGPT',
      creator: 'Abdus Nilom',
      exportedAt: new Date().toISOString(),
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          editedAt: m.editedAt,
        })),
      },
    },
    null,
    2
  );
}

export function triggerFileDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
