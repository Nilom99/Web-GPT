export type MessageRole = 'user' | 'assistant';

export interface ChatMessageItem {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  editedAt?: number;
  isStreaming?: boolean;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessageItem[];
  createdAt: number;
  updatedAt: number;
}

export type ThemeMode = 'light' | 'dark';

export interface ModelStatusResponse {
  status: 'loading' | 'ready' | 'error';
  label: 'Loading...' | 'Ready' | 'Unavailable';
  ready: boolean;
}
