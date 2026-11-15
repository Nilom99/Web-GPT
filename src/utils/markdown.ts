import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import { Marked, Renderer } from 'marked';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('md', markdownLang);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const renderer = new Renderer();

renderer.code = ({ text, lang }) => {
  const safeLang = (lang || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  let highlighted: string;
  if (safeLang && hljs.getLanguage(safeLang)) {
    highlighted = hljs.highlight(text, { language: safeLang }).value;
  } else {
    highlighted = escapeHtml(text);
  }
  const label = safeLang || 'code';
  const encodedRaw = encodeURIComponent(text);

  return (
    `<div class="webgpt-code-wrapper">` +
    `<div class="webgpt-code-header">` +
    `<span>${escapeHtml(label)}</span>` +
    `<button type="button" class="webgpt-copy-code-btn px-2 py-0.5 rounded text-xs font-sans font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer" data-code="${encodedRaw}">Copy</button>` +
    `</div>` +
    `<pre><code class="hljs${safeLang ? ` language-${escapeHtml(safeLang)}` : ''}">${highlighted}</code></pre>` +
    `</div>`
  );
};

renderer.link = ({ href, title, text }) => {
  const safeHref = href && /^https?:\/\//i.test(href) ? escapeHtml(href) : '#';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

// Block raw HTML passthrough in Markdown before DOMPurify sanitization
renderer.html = ({ text }) => escapeHtml(text);

const markedInstance = new Marked({
  gfm: true,
  breaks: true,
  renderer,
});

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'a',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'div',
  'span',
  'button',
];

const ALLOWED_ATTR = [
  'class',
  'href',
  'target',
  'rel',
  'title',
  'type',
  'data-code',
];

export function renderSafeMarkdown(markdownText: string): string {
  const rawHtml = markedInstance.parse(markdownText) as string;
  if (typeof window === 'undefined') {
    // Fallback for non-DOM environments (e.g. Node unit tests)
    return rawHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['data-code', 'target', 'rel'],
  });
}
