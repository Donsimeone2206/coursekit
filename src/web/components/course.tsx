import { BookOpen, Users } from 'lucide-react';
import { Link } from 'react-router';
import type { ActivityType, CourseSummary } from '@shared/types';
import { ACTIVITY_META } from '@/lib/activity';
import { coverStyle } from '@/lib/covers';
import { cn, plural } from '@/lib/utils';
import { AvatarStack } from './ui/avatar';
import { Badge } from './ui/badge';
import { Progress } from './ui/misc';

export function CourseCover({
  color,
  imageUrl,
  title,
  className,
  children,
}: {
  color: string;
  imageUrl?: string | null;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('relative overflow-hidden', className)} style={coverStyle(color, imageUrl)}>
      {title && !imageUrl && (
        <span className="pointer-events-none absolute -right-2 -bottom-6 text-[96px] leading-none font-black tracking-tighter text-white/15 select-none">
          {title
            .split(/\s+/)
            .slice(0, 2)
            .map((w) => w[0])
            .join('')}
        </span>
      )}
      {children}
    </div>
  );
}

const ROLE_BADGE: Record<string, { label: string; variant: 'default' | 'violet' | 'info' }> = {
  teacher: { label: 'Teaching', variant: 'violet' },
  assistant: { label: 'Assisting', variant: 'info' },
  student: { label: 'Enrolled', variant: 'default' },
};

export function CourseCard({ course, showProgress = true }: { course: CourseSummary; showProgress?: boolean }) {
  const role = course.myRole ? ROLE_BADGE[course.myRole] : null;
  return (
    <Link
      to={`/courses/${course.slug}`}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/5 dark:hover:shadow-black/30"
    >
      <CourseCover color={course.coverColor} imageUrl={course.coverImageUrl} title={course.title} className="h-28">
        <div className="absolute inset-x-3 top-3 flex items-center justify-between gap-2">
          {course.categoryName ? (
            <span className="rounded-full bg-black/20 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
              {course.categoryName}
            </span>
          ) : (
            <span />
          )}
          {course.visibility !== 'published' && (
            <span className="rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-slate-800 capitalize">
              {course.visibility}
            </span>
          )}
        </div>
      </CourseCover>
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 font-semibold leading-snug tracking-tight group-hover:text-primary">{course.title}</h3>
          {role && (
            <Badge variant={role.variant} className="mt-0.5 shrink-0">
              {role.label}
            </Badge>
          )}
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{course.summary}</p>
        <div className="mt-auto pt-4">
          {showProgress && course.progress != null ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-semibold tabular-nums">{course.progress}%</span>
              </div>
              <Progress value={course.progress} tone={course.progress === 100 ? 'success' : 'primary'} />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                <AvatarStack users={course.teachers} max={2} />
                <span className="truncate">{course.teachers.map((t) => t.name).join(', ') || 'No teacher yet'}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="flex items-center gap-1">
                  <Users className="size-3.5" />
                  {course.studentCount}
                </span>
                <span className="flex items-center gap-1">
                  <BookOpen className="size-3.5" />
                  {course.activityCount}
                </span>
              </span>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

export function CourseCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="h-28 animate-pulse bg-muted" />
      <div className="space-y-2.5 p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

export function ActivityIcon({ type, className, size = 'md' }: { type: ActivityType; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const meta = ACTIVITY_META[type];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-lg',
        meta.tint,
        size === 'sm' && 'size-7 [&_svg]:size-3.5',
        size === 'md' && 'size-9 [&_svg]:size-4',
        size === 'lg' && 'size-11 rounded-xl [&_svg]:size-5',
        className,
      )}
    >
      <Icon />
    </span>
  );
}

export function studentsLabel(n: number) {
  return plural(n, 'student');
}
