import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  maxChars?: number;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isGenerating,
  disabled = false,
  maxChars = 4000,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!isGenerating && !disabled && value.trim()) {
        onSubmit();
      }
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isGenerating) {
      onStop();
      return;
    }
    if (!disabled && value.trim()) {
      onSubmit();
    }
  };

  const charCount = value.length;
  const nearLimit = charCount > maxChars * 0.85;

  return (
    <div className="border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0B0E14]/95 px-4 py-3 sm:px-6">
      <form
        onSubmit={handleFormSubmit}
        className="mx-auto max-w-3xl"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-slate-300 dark:border-slate-700 bg-[#F7F8FA] dark:bg-[#121721] px-3.5 py-2.5 focus-within:border-teal-600 dark:focus-within:border-teal-500 transition-colors">
          <label htmlFor="chat-prompt-input" className="sr-only">
            Message WebGPT
          </label>
          <textarea
            id="chat-prompt-input"
            ref={textareaRef}
            rows={1}
            value={value}
            maxLength={maxChars}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message WebGPT..."
            className="flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none disabled:opacity-60 max-h-[180px]"
          />

          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generation"
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white text-white dark:text-slate-900 px-3.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={disabled || !value.trim()}
              aria-label="Send message"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 dark:bg-teal-600 dark:hover:bg-teal-500 dark:disabled:bg-slate-800 text-white disabled:text-slate-500 dark:disabled:text-slate-600 transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="truncate">WebGPT · Created by Abdus Nilom</span>
          <span
            className={`tabular-nums whitespace-nowrap shrink-0 ${
              charCount > 0 ? '' : 'hidden sm:inline'
            } ${nearLimit ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}
          >
            {charCount > 0 ? `${charCount} / ${maxChars}` : 'Enter to send · Shift+Enter for new line'}
          </span>
        </div>
      </form>
    </div>
  );
}
