interface EmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
}

const STARTER_PROMPTS = [
  {
    title: 'Explain a concept clearly',
    prompt: 'Explain how photosynthesis works in simple terms.',
  },
  {
    title: 'Write clean code',
    prompt: 'Write a TypeScript function to debounce search input.',
  },
  {
    title: 'Draft a quick message',
    prompt: 'Help me write a polite follow-up email after a project meeting.',
  },
  {
    title: 'Brainstorm ideas',
    prompt: 'Give me 5 practical study habits to stay focused.',
  },
];

export function EmptyState({ onSelectPrompt }: EmptyStateProps) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center justify-center px-4 py-12 sm:py-20 text-center">
      <div
        aria-hidden="true"
        className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-700 dark:bg-teal-600 text-white font-display text-lg font-bold tracking-tight"
      >
        WG
      </div>

      <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 text-balance">
        WebGPT
      </h1>
      <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
        Created by Abdus Nilom
      </p>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        Ask a question, draft writing, explore ideas, or work through code together.
      </p>

      <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-2 text-left">
        {STARTER_PROMPTS.map((item) => (
          <button
            key={item.title}
            type="button"
            onClick={() => onSelectPrompt(item.prompt)}
            className="text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-[#F7F8FA] dark:bg-[#121721] hover:border-teal-600/60 dark:hover:border-teal-500/60 hover:bg-white dark:hover:bg-[#161C28] p-4 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-teal-600"
          >
            <div className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              {item.title}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400 line-clamp-2">
              {item.prompt}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
