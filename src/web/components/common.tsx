import { FileText, Paperclip, Trash2, Upload, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { FileInfo } from '@shared/types';
import { api, errorMessage } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { Button } from './ui/button';
import { Spinner } from './ui/misc';

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-sm font-medium text-muted-foreground">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[15px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'primary',
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'primary' | 'emerald' | 'amber' | 'violet' | 'sky' | 'rose';
}) {
  const tones = {
    primary: 'bg-primary/10 text-primary',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    amber: 'bg-amber-500/12 text-amber-600 dark:text-amber-400',
    violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    sky: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  };
  return (
    <div className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        <span className={cn('grid size-8 place-items-center rounded-lg', tones[tone])}>
          <Icon className="size-4" />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-[15px] font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

export function FileChip({ file, onRemove }: { file: FileInfo; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <FileText className="size-4" />
      </span>
      <a href={file.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 hover:underline">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="block text-xs text-muted-foreground">{formatBytes(file.size)}</span>
      </a>
      {onRemove && (
        <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove} aria-label={`Remove ${file.name}`}>
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

/** Drag-and-drop uploader that uploads immediately and reports the stored file. */
export function FileDrop({
  context,
  courseId,
  onUploaded,
  multiple = false,
  disabled,
  accept,
  label = 'Drop files here or click to upload',
}: {
  context: 'course' | 'activity' | 'submission' | 'avatar' | 'post';
  courseId?: string;
  onUploaded: (file: FileInfo) => void;
  multiple?: boolean;
  disabled?: boolean;
  accept?: string;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(0);

  const upload = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setBusy((n) => n + 1);
      try {
        onUploaded(await api.upload(file, { context, courseId }));
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled && e.dataTransfer.files.length) void upload(multiple ? e.dataTransfer.files : [e.dataTransfer.files[0]!]);
      }}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.03] disabled:pointer-events-none disabled:opacity-50',
        dragging && 'border-primary bg-primary/5',
      )}
    >
      <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
        {busy > 0 ? <Spinner /> : <Upload className="size-4.5" />}
      </span>
      <span className="text-sm font-medium">{busy > 0 ? 'Uploading…' : label}</span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Paperclip className="size-3" /> Any file type, up to 50 MB
      </span>
      <input
        ref={input}
        type="file"
        hidden
        multiple={multiple}
        accept={accept}
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files);
          e.target.value = '';
        }}
      />
    </button>
  );
}
