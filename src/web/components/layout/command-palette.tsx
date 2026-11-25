import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
  BookOpen,
  CalendarDays,
  Compass,
  CornerDownLeft,
  LayoutDashboard,
  Moon,
  Plus,
  Search,
  ShieldCheck,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { canCreateCourses } from '@shared/permissions';
import type { SearchResults } from '@shared/types';
import { activityPath } from '@/lib/activity';
import { api } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { useDebounced } from '@/lib/hooks';
import { useMe } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { ActivityIcon } from '../course';
import { Avatar } from '../ui/avatar';
import { Dialog, DialogContent } from '../ui/dialog';
import { Kbd, Spinner } from '../ui/misc';

const itemClass =
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground data-[selected=true]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0';
const groupClass =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase';

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 200);
  const navigate = useNavigate();
  const me = useMe();
  const { resolved, setTheme } = useTheme();

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<SearchResults>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
    placeholderData: (prev) => prev,
  });

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  const links: Array<{ label: string; icon: LucideIcon; path: string; show?: boolean }> = [
    { label: 'Dashboard', icon: LayoutDashboard, path: '/' },
    { label: 'My courses', icon: BookOpen, path: '/my-courses' },
    { label: 'Explore courses', icon: Compass, path: '/catalog' },
    { label: 'Calendar', icon: CalendarDays, path: '/calendar' },
    { label: 'Profile', icon: User, path: '/profile' },
    { label: 'Create a course', icon: Plus, path: '/courses/new', show: canCreateCourses(me?.role) },
    { label: 'Administration', icon: ShieldCheck, path: '/admin', show: me?.role === 'admin' },
    { label: 'Manage users', icon: Users, path: '/admin/users', show: me?.role === 'admin' },
  ];
  const q = query.trim().toLowerCase();
  const visibleLinks = links.filter((l) => l.show !== false && (!q || l.label.toLowerCase().includes(q)));
  const searching = debounced.length >= 2;
  const results = searching ? data : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className="top-[15%] max-w-xl translate-y-0 overflow-hidden p-0" aria-describedby={undefined}>
        <Command shouldFilter={false} label="Search" className="flex flex-col">
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-4.5 shrink-0 text-muted-foreground" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search courses, activities and people…"
              className="h-13 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            />
            {isFetching && <Spinner className="size-4" />}
          </div>
          <Command.List className="ck-scrollbar max-h-[min(60vh,28rem)] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-10 text-center text-sm text-muted-foreground">
              {searching ? 'No matches. Try a different search.' : 'Type to search.'}
            </Command.Empty>

            {results && results.courses.length > 0 && (
              <Command.Group heading="Courses" className={groupClass}>
                {results.courses.map((c) => (
                  <Command.Item key={c.id} value={`course-${c.id}`} onSelect={() => go(`/courses/${c.slug}`)} className={itemClass}>
                    <span className="size-6 shrink-0 rounded-md" style={coverDot(c.coverColor)} />
                    <span className="truncate">{c.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {results && results.activities.length > 0 && (
              <Command.Group heading="Activities" className={groupClass}>
                {results.activities.map((a) => (
                  <Command.Item
                    key={a.id}
                    value={`activity-${a.id}`}
                    onSelect={() => go(activityPath(a.course.slug, a.id))}
                    className={itemClass}
                  >
                    <ActivityIcon type={a.type} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{a.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{a.course.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {results && results.users.length > 0 && (
              <Command.Group heading="People" className={groupClass}>
                {results.users.map((u) => (
                  <Command.Item
                    key={u.id}
                    value={`user-${u.id}`}
                    onSelect={() => go(`/admin/users?q=${encodeURIComponent(u.email)}`)}
                    className={itemClass}
                  >
                    <Avatar user={u} size="xs" />
                    <span className="truncate">{u.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {visibleLinks.length > 0 && (
              <Command.Group heading="Go to" className={groupClass}>
                {visibleLinks.map((l) => (
                  <Command.Item key={l.path} value={`link-${l.path}`} onSelect={() => go(l.path)} className={itemClass}>
                    <l.icon className="text-muted-foreground" />
                    {l.label}
                  </Command.Item>
                ))}
                {(!q || 'theme dark light'.includes(q)) && (
                  <Command.Item
                    value="toggle-theme"
                    onSelect={() => {
                      setTheme(resolved === 'dark' ? 'light' : 'dark');
                      onOpenChange(false);
                    }}
                    className={itemClass}
                  >
                    <Moon className="text-muted-foreground" />
                    Switch to {resolved === 'dark' ? 'light' : 'dark'} mode
                  </Command.Item>
                )}
              </Command.Group>
            )}
          </Command.List>
          <div className="flex items-center gap-4 border-t bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to navigate
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>
              to open
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd> to close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
