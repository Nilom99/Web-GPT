import { Download, Menu } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatInput } from './components/ChatInput';
import { ChatMessage } from './components/ChatMessage';
import { EmptyState } from './components/EmptyState';
import { Sidebar } from './components/Sidebar';
import type { ChatMessageItem, Conversation, ModelStatusResponse, ThemeMode } from './types/chat';
import {
  fetchModelStatus,
  stopGenerationRequest,
  streamChatCompletion,
} from './utils/api';
import {
  deleteConversationById,
  deriveConversationTitle,
  formatConversationAsJson,
  formatConversationAsTxt,
  loadActiveConversationId,
  loadAllConversations,
  loadThemePreference,
  saveActiveConversationId,
  saveConversation,
  saveThemePreference,
  triggerFileDownload,
} from './utils/storage';

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [theme, setTheme] = useState<ThemeMode>(() => loadThemePreference());
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatusResponse>({
    status: 'loading',
    label: 'Loading...',
    ready: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Sync theme class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveThemePreference(theme);
  }, [theme]);

  // Hydrate conversations from IndexedDB
  useEffect(() => {
    let mounted = true;
    (async () => {
      const saved = await loadAllConversations();
      if (!mounted) return;
      setConversations(saved);
      const preferredId = loadActiveConversationId();
      if (preferredId && saved.some((c) => c.id === preferredId)) {
        setActiveId(preferredId);
      } else if (saved.length > 0) {
        setActiveId(saved[0].id);
      }
      setIsHydrated(true);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (isHydrated) {
      saveActiveConversationId(activeId);
    }
  }, [activeId, isHydrated]);

  // Poll assistant readiness status cleanly (never showing internal model details)
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (init = false) => {
      try {
        const res = await fetchModelStatus(init);
        if (!active) return;
        setModelStatus(res);
        if (!res.ready && res.status === 'loading') {
          timer = setTimeout(() => poll(false), 1500);
        }
      } catch {
        if (!active) return;
        setModelStatus({ status: 'error', label: 'Unavailable', ready: false });
      }
    };

    poll(true);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  // Auto-scroll when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: isGenerating ? 'auto' : 'smooth' });
  }, [activeConversation?.messages.length, activeConversation?.messages[activeConversation.messages.length - 1]?.content, isGenerating]);

  const upsertAndPersist = useCallback(async (updated: Conversation) => {
    setConversations((prev) => {
      const exists = prev.some((c) => c.id === updated.id);
      const next = exists
        ? prev.map((c) => (c.id === updated.id ? updated : c))
        : [updated, ...prev];
      return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    try {
      await saveConversation(updated);
    } catch {
      setBannerError('Unable to save conversation to browser storage.');
    }
  }, []);

  const runAssistantTurn = useCallback(
    async (conv: Conversation, assistantMessageId: string) => {
      const requestId = createId('req');
      const controller = new AbortController();
      abortRef.current = controller;
      activeRequestIdRef.current = requestId;
      setIsGenerating(true);
      setBannerError(null);

      const historyPayload = conv.messages
        .filter((m) => m.id !== assistantMessageId && !m.error && m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content }));

      let accumulated = '';
      let streamErr: string | null = null;

      try {
        await streamChatCompletion(
          {
            requestId,
            messages: historyPayload,
            signal: controller.signal,
          },
          {
            onStatus: (status) => {
              if (status === 'ready') {
                setModelStatus({ status: 'ready', label: 'Ready', ready: true });
              } else {
                setModelStatus({ status: 'loading', label: 'Loading...', ready: false });
              }
            },
            onToken: (token) => {
              accumulated += token;
              setConversations((prev) =>
                prev.map((c) =>
                  c.id !== conv.id
                    ? c
                    : {
                        ...c,
                        updatedAt: Date.now(),
                        messages: c.messages.map((m) =>
                          m.id === assistantMessageId
                            ? { ...m, content: accumulated, isStreaming: true }
                            : m
                        ),
                      }
                )
              );
            },
            onError: (errMsg) => {
              streamErr = errMsg;
            },
          }
        );
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          streamErr = err instanceof Error ? err.message : 'Unable to complete response.';
        }
      } finally {
        abortRef.current = null;
        activeRequestIdRef.current = null;
        setIsGenerating(false);

        const finalContent = accumulated.trim();
        const finalizedConv: Conversation = {
          ...conv,
          updatedAt: Date.now(),
          messages: conv.messages.map((m) =>
            m.id === assistantMessageId
              ? {
                  ...m,
                  content: finalContent || (streamErr ? '' : 'Response stopped.'),
                  isStreaming: false,
                  error: streamErr || undefined,
                }
              : m
          ),
        };
        await upsertAndPersist(finalizedConv);
      }
    },
    [upsertAndPersist]
  );

  const handleSendMessage = useCallback(
    async (explicitPrompt?: string) => {
      const text = (explicitPrompt ?? inputValue).trim();
      if (!text || isGenerating) return;
      if (!explicitPrompt) {
        setInputValue('');
      }
      setBannerError(null);

      const now = Date.now();
      const userMsg: ChatMessageItem = {
        id: createId('msg'),
        role: 'user',
        content: text,
        createdAt: now,
      };
      const assistantMsg: ChatMessageItem = {
        id: createId('msg'),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
        isStreaming: true,
      };

      let targetConv: Conversation;
      if (activeConversation) {
        const shouldSetTitle = activeConversation.messages.length === 0;
        targetConv = {
          ...activeConversation,
          title: shouldSetTitle ? deriveConversationTitle(text) : activeConversation.title,
          updatedAt: now,
          messages: [...activeConversation.messages, userMsg, assistantMsg],
        };
      } else {
        targetConv = {
          id: createId('conv'),
          title: deriveConversationTitle(text),
          createdAt: now,
          updatedAt: now,
          messages: [userMsg, assistantMsg],
        };
        setActiveId(targetConv.id);
      }

      await upsertAndPersist(targetConv);
      await runAssistantTurn(targetConv, assistantMsg.id);
    },
    [activeConversation, inputValue, isGenerating, runAssistantTurn, upsertAndPersist]
  );

  const handleStopGeneration = useCallback(() => {
    const reqId = activeRequestIdRef.current;
    if (reqId) {
      void stopGenerationRequest(reqId);
    }
    abortRef.current?.abort();
  }, []);

  const handleNewChat = useCallback(() => {
    if (isGenerating) {
      handleStopGeneration();
    }
    setActiveId(null);
    setBannerError(null);
  }, [handleStopGeneration, isGenerating]);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      if (id === activeId && isGenerating) {
        handleStopGeneration();
      }
      setConversations((prev) => {
        const remaining = prev.filter((c) => c.id !== id);
        if (id === activeId) {
          setActiveId(remaining.length > 0 ? remaining[0].id : null);
        }
        return remaining;
      });
      await deleteConversationById(id).catch(() => {});
    },
    [activeId, handleStopGeneration, isGenerating]
  );

  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!activeConversation || isGenerating) return;
      const idx = activeConversation.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      const now = Date.now();
      const kept = activeConversation.messages.slice(0, idx + 1).map((m, i) =>
        i === idx ? { ...m, content: newContent, editedAt: now } : m
      );
      const assistantMsg: ChatMessageItem = {
        id: createId('msg'),
        role: 'assistant',
        content: '',
        createdAt: now + 1,
        isStreaming: true,
      };

      const updated: Conversation = {
        ...activeConversation,
        title: idx === 0 ? deriveConversationTitle(newContent) : activeConversation.title,
        updatedAt: now,
        messages: [...kept, assistantMsg],
      };

      await upsertAndPersist(updated);
      await runAssistantTurn(updated, assistantMsg.id);
    },
    [activeConversation, isGenerating, runAssistantTurn, upsertAndPersist]
  );

  const handleRegenerate = useCallback(
    async (assistantMessageId: string) => {
      if (!activeConversation || isGenerating) return;
      const idx = activeConversation.messages.findIndex((m) => m.id === assistantMessageId);
      if (idx === -1) return;

      // Keep messages up to the preceding user message
      const prefix = activeConversation.messages.slice(0, idx);
      const now = Date.now();
      const freshAssistant: ChatMessageItem = {
        id: createId('msg'),
        role: 'assistant',
        content: '',
        createdAt: now,
        isStreaming: true,
      };

      const updated: Conversation = {
        ...activeConversation,
        updatedAt: now,
        messages: [...prefix, freshAssistant],
      };

      await upsertAndPersist(updated);
      await runAssistantTurn(updated, freshAssistant.id);
    },
    [activeConversation, isGenerating, runAssistantTurn, upsertAndPersist]
  );

  const handleCopyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setBannerError('Clipboard permission denied.');
    }
  }, []);

  const handleExportTxt = useCallback(() => {
    if (!activeConversation) return;
    const slug = activeConversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'chat';
    triggerFileDownload(
      `webgpt-${slug}.txt`,
      formatConversationAsTxt(activeConversation),
      'text/plain;charset=utf-8'
    );
  }, [activeConversation]);

  const handleExportJson = useCallback(() => {
    if (!activeConversation) return;
    const slug = activeConversation.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'chat';
    triggerFileDownload(
      `webgpt-${slug}.json`,
      formatConversationAsJson(activeConversation),
      'application/json;charset=utf-8'
    );
  }, [activeConversation]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-white text-slate-900 dark:bg-[#0B0E14] dark:text-slate-100">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        theme={theme}
        isOpenMobile={isSidebarOpen}
        onCloseMobile={() => setIsSidebarOpen(false)}
        onNewChat={handleNewChat}
        onSelectConversation={(id) => {
          setActiveId(id);
          setBannerError(null);
        }}
        onDeleteConversation={handleDeleteConversation}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      <div className="flex min-w-0 flex-1 flex-col h-full">
        {/* Top Header */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 bg-white dark:bg-[#0B0E14]">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open conversation sidebar"
              className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white transition-colors cursor-pointer"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="font-display text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">
              {activeConversation ? activeConversation.title : 'WebGPT'}
            </span>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <span
              data-testid="assistant-status"
              className={`text-xs font-medium whitespace-nowrap ${
                modelStatus.status === 'ready'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : modelStatus.status === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {modelStatus.label}
            </span>

            {activeConversation && activeConversation.messages.length > 0 && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleExportTxt}
                  aria-label="Export conversation as TXT"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>TXT</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportJson}
                  aria-label="Export conversation as JSON"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>JSON</span>
                </button>
              </div>
            )}
          </div>
        </header>

        {bannerError && (
          <div
            role="alert"
            className="border-b border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-4 py-2 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2"
          >
            <span>{bannerError}</span>
            <button
              type="button"
              onClick={() => setBannerError(null)}
              className="underline hover:no-underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Main Chat Viewport */}
        <main className="flex-1 overflow-y-auto">
          {!activeConversation || activeConversation.messages.length === 0 ? (
            <EmptyState onSelectPrompt={(prompt) => void handleSendMessage(prompt)} />
          ) : (
            <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 space-y-6">
              {activeConversation.messages.map((msg) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  isGenerating={isGenerating}
                  onCopy={handleCopyText}
                  onEditSubmit={handleEditMessage}
                  onRegenerate={handleRegenerate}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </main>

        {/* Bottom Prompt Composer */}
        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={() => void handleSendMessage()}
          onStop={handleStopGeneration}
          isGenerating={isGenerating}
        />
      </div>
    </div>
  );
}
