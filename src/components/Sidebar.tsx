import { MessageSquare, Moon, Plus, Search, Sun, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Conversation, ThemeMode } from '../types/chat';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  theme: ThemeMode;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onToggleTheme: () => void;
}

function formatRelativeDate(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Sidebar({
  conversations,
  activeId,
  theme,
  isOpenMobile,
  onCloseMobile,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onToggleTheme,
}: SidebarProps) {
  const [query, setQuery] = useState('');

  const filteredConversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conv) => conv.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const sidebarBody = (
    <div className="flex h-full flex-col bg-[#F7F8FA] text-slate-900 dark:bg-[#121721] dark:text-slate-100 border-r border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <div className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-slate-50 truncate">
            WebGPT
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
            Created by Abdus Nilom
          </div>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close sidebar"
          className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-3 pb-3 space-y-2.5">
        <button
          type="button"
          onClick={() => {
            onNewChat();
            onCloseMobile();
          }}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-500 text-white px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span>New chat</span>
        </button>

        <div className="relative">
          <label htmlFor="conversation-search" className="sr-only">
            Search conversations
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
            aria-hidden="true"
          />
          <input
            id="conversation-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats..."
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-[#0B0E14] pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 dark:focus:border-teal-500"
          />
        </div>
      </div>

      <nav
        aria-label="Conversation history"
        className="flex-1 overflow-y-auto px-2.5 py-1 space-y-1"
      >
        {filteredConversations.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
            {conversations.length === 0
              ? 'No saved conversations yet.'
              : 'No matching conversations.'}
          </div>
        ) : (
          filteredConversations.map((conv) => {
            const isActive = conv.id === activeId;
            return (
              <div
                key={conv.id}
                className={`group flex items-center gap-1 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-white dark:bg-[#1B2230] text-slate-900 dark:text-slate-50 border border-slate-200/90 dark:border-slate-700/70'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectConversation(conv.id);
                    onCloseMobile();
                  }}
                  className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-teal-600 rounded-lg"
                >
                  <MessageSquare
                    className={`h-4 w-4 shrink-0 ${
                      isActive ? 'text-teal-700 dark:text-teal-400' : 'text-slate-400'
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{conv.title}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      {formatRelativeDate(conv.updatedAt)}
                      <span aria-hidden="true"> · </span>
                      {conv.messages.length} msg{conv.messages.length === 1 ? '' : 's'}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteConversation(conv.id)}
                  aria-label={`Delete conversation "${conv.title}"`}
                  className="mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-75 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 transition-colors cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </nav>

      <div className="border-t border-slate-200 dark:border-slate-800 p-3">
        <button
          type="button"
          onClick={onToggleTheme}
          className="w-full flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2.5">
            {theme === 'dark' ? (
              <Sun className="h-4 w-4 text-amber-400" />
            ) : (
              <Moon className="h-4 w-4 text-slate-600" />
            )}
            <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {theme === 'dark' ? 'Dark' : 'Light'}
          </span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop fixed sidebar */}
      <aside className="hidden md:block w-[268px] shrink-0 h-full">{sidebarBody}</aside>

      {/* Mobile slide-over drawer */}
      {isOpenMobile && (
        <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true" aria-label="Sidebar navigation">
          <div
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-[1px]"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-[280px] max-w-[85vw] h-full shadow-xl">
            {sidebarBody}
          </aside>
        </div>
      )}
    </>
  );
}
