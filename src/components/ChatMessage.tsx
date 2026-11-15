import { Check, Copy, Pencil, RotateCcw, User, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ChatMessageItem } from '../types/chat';
import { renderSafeMarkdown } from '../utils/markdown';

interface ChatMessageProps {
  message: ChatMessageItem;
  isGenerating: boolean;
  onCopy: (content: string) => Promise<void> | void;
  onEditSubmit: (messageId: string, newContent: string) => void;
  onRegenerate: (messageId: string) => void;
}

export function ChatMessage({
  message,
  isGenerating,
  onCopy,
  onEditSubmit,
  onRegenerate,
}: ChatMessageProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);

  const renderedHtml = useMemo(() => {
    if (message.role === 'user') return '';
    return renderSafeMarkdown(message.content);
  }, [message.role, message.content]);

  const handleCopy = async () => {
    await onCopy(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleProseClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const button = target.closest('.webgpt-copy-code-btn') as HTMLButtonElement | null;
    if (!button) return;

    const encoded = button.getAttribute('data-code');
    if (!encoded) return;
    try {
      const code = decodeURIComponent(encoded);
      await navigator.clipboard.writeText(code);
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = original || 'Copy';
      }, 1500);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setIsEditing(false);
    if (trimmed !== message.content) {
      onEditSubmit(message.id, trimmed);
    }
  };

  const timeLabel = new Date(message.createdAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (message.role === 'user') {
    return (
      <article
        data-testid={`message-user-${message.id}`}
        className="group flex justify-end"
      >
        <div className="max-w-[85%] sm:max-w-[75%] space-y-1.5">
          {isEditing ? (
            <form
              onSubmit={handleSaveEdit}
              className="rounded-2xl border border-teal-600/50 bg-slate-50 dark:bg-[#151B27] p-3 space-y-2.5 min-w-[260px] sm:min-w-[380px]"
            >
              <label htmlFor={`edit-${message.id}`} className="sr-only">
                Edit your message
              </label>
              <textarea
                id={`edit-${message.id}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                className="w-full resize-y rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0E14] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-teal-600"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDraft(message.content);
                    setIsEditing(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Cancel</span>
                </button>
                <button
                  type="submit"
                  disabled={!draft.trim() || isGenerating}
                  className="inline-flex items-center gap-1 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                >
                  <span>Save & Submit</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="flex items-start justify-end gap-2.5">
              <div className="rounded-2xl bg-slate-900 text-white dark:bg-teal-700 dark:text-white px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                {message.content}
              </div>
              <div
                aria-hidden="true"
                className="mt-1 hidden sm:flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                <User className="h-3.5 w-3.5" />
              </div>
            </div>
          )}

          {!isEditing && (
            <div className="flex items-center justify-end gap-2 pr-1 sm:pr-9 text-[11px] text-slate-400 dark:text-slate-500">
              <span className="tabular-nums">{timeLabel}</span>
              {message.editedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Edited</span>
                </>
              )}
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy user message"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
              {!isGenerating && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(message.content);
                    setIsEditing(true);
                  }}
                  aria-label="Edit user message"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <Pencil className="h-3 w-3" />
                  <span>Edit</span>
                </button>
              )}
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <article
      data-testid={`message-assistant-${message.id}`}
      className="group flex items-start gap-3 sm:gap-3.5"
    >
      <div
        aria-hidden="true"
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-700 dark:bg-teal-600 text-white font-display text-xs font-bold tracking-tight"
      >
        WG
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-display font-semibold text-slate-900 dark:text-slate-100">
            WebGPT
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{timeLabel}</span>
          {message.isStreaming && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-teal-700 dark:text-teal-400 font-medium">Responding...</span>
            </>
          )}
        </div>

        {message.isStreaming && !message.content && !message.error ? (
          <div className="py-1 text-sm text-slate-500 dark:text-slate-400">
            Thinking...
          </div>
        ) : (
          <>
            {message.content && (
              <div
                onClick={handleProseClick}
                className="webgpt-prose text-slate-800 dark:text-slate-100"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            )}
            {message.error && (
              <div
                role="alert"
                className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-300"
              >
                {message.error}
              </div>
            )}
          </>
        )}

        {!message.isStreaming && (
          <div className="flex items-center gap-1.5 pt-0.5">
            {message.content && (
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy assistant response"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}

            {!isGenerating && (
              <button
                type="button"
                onClick={() => onRegenerate(message.id)}
                aria-label="Regenerate response"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Regenerate</span>
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
