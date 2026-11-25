import DOMPurify from 'dompurify';
import { Bold, Code, Heading2, Italic, Link2, List, ListOrdered, Quote } from 'lucide-react';
import { Marked } from 'marked';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Textarea } from './ui/form';

const marked = new Marked({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')?.match(/^https?:\/\//)) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source ?? '', { async: false }) as string);
}

export function renderInline(source: string): string {
  return DOMPurify.sanitize(marked.parseInline(source ?? '', { async: false }) as string);
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={cn('ck-prose', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Inline markdown (bold, code, links) without block elements, e.g. quiz options. */
export function InlineMarkdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderInline(source), [source]);
  return <span className={cn('ck-inline-prose', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

type Action = { icon: ReactNode; label: string; apply: (selected: string) => { text: string; cursorOffset?: number } };

const ACTIONS: Action[] = [
  { icon: <Heading2 />, label: 'Heading', apply: (s) => ({ text: `## ${s || 'Heading'}` }) },
  { icon: <Bold />, label: 'Bold', apply: (s) => ({ text: `**${s || 'bold text'}**` }) },
  { icon: <Italic />, label: 'Italic', apply: (s) => ({ text: `_${s || 'italic text'}_` }) },
  { icon: <Link2 />, label: 'Link', apply: (s) => ({ text: `[${s || 'link text'}](https://)` }) },
  { icon: <Code />, label: 'Code', apply: (s) => ({ text: s.includes('\n') ? `\`\`\`\n${s}\n\`\`\`` : `\`${s || 'code'}\`` }) },
  { icon: <Quote />, label: 'Quote', apply: (s) => ({ text: `> ${s || 'Quote'}` }) },
  {
    icon: <List />,
    label: 'Bulleted list',
    apply: (s) => ({
      text: (s || 'Item')
        .split('\n')
        .map((l) => `- ${l}`)
        .join('\n'),
    }),
  },
  {
    icon: <ListOrdered />,
    label: 'Numbered list',
    apply: (s) => ({
      text: (s || 'Item')
        .split('\n')
        .map((l, i) => `${i + 1}. ${l}`)
        .join('\n'),
    }),
  },
];

/** Markdown editor with a small formatting toolbar and a live preview tab. */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  rows = 8,
  id,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const ref = useRef<HTMLTextAreaElement>(null);

  const apply = (action: Action) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const { text } = action.apply(value.slice(start, end));
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + text.length);
    });
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-input bg-card shadow-xs focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/15',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-1.5 py-1">
        <div className="flex items-center gap-0.5">
          {(['write', 'preview'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium capitalize text-muted-foreground transition-colors hover:text-foreground',
                tab === t && 'bg-card text-foreground shadow-xs',
              )}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === 'write' && (
          <div className="flex items-center gap-0.5 overflow-x-auto">
            {ACTIONS.map((a) => (
              <button
                key={a.label}
                type="button"
                title={a.label}
                onClick={() => apply(a)}
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              >
                {a.icon}
              </button>
            ))}
          </div>
        )}
      </div>
      {tab === 'write' ? (
        <Textarea
          ref={ref}
          id={id}
          value={value}
          rows={rows}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-none border-0 font-mono text-[13px] shadow-none focus-visible:ring-0"
        />
      ) : (
        <div className="min-h-24 px-4 py-3" style={{ minHeight: `${rows * 1.6}rem` }}>
          {value.trim() ? (
            <Markdown source={value} className="prose-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      )}
      <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        Markdown supported: **bold**, _italic_, `code`, lists, tables and links.
      </div>
    </div>
  );
}
