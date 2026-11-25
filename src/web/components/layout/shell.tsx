import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Award,
  Bell,
  BookOpen,
  CalendarDays,
  Compass,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Medal,
  Megaphone,
  Menu,
  MessageCircle,
  Moon,
  Palette,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  User as UserIcon,
  UserCog,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { canCreateCourses, SITE_ROLE_LABELS } from '@shared/permissions';
import type { AppNotification, CourseSummary, SessionInfo } from '@shared/types';
import { api, errorMessage } from '@/lib/api';
import { coverDot } from '@/lib/covers';
import { useMe, useSession, useSetSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { cn, formatRelative } from '@/lib/utils';
import { Avatar } from '../ui/avatar';
import { Button } from '../ui/button';
import { Dialog, SheetContent } from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/menu';
import { Kbd } from '../ui/misc';
import { CommandPalette } from './command-palette';

export function Logo({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <span className="grid size-8 place-items-center rounded-[10px] bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm shadow-primary/30">
        <GraduationCap className="size-[18px]" />
      </span>
      <span className="truncate text-[15px] font-semibold tracking-tight">{name}</span>
    </span>
  );
}

function NavItem({
  to,
  icon: Icon,
  children,
  end,
  onNavigate,
}: {
  to: string;
  icon: LucideIcon;
  children: ReactNode;
  end?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground',
          isActive && 'bg-card text-foreground shadow-xs ring-1 ring-border',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cn('size-[18px] shrink-0', isActive && 'text-primary')} />
          <span className="truncate">{children}</span>
        </>
      )}
    </NavLink>
  );
}

function CourseNavItem({ course, onNavigate }: { course: CourseSummary; onNavigate?: () => void }) {
  return (
    <NavLink
      to={`/courses/${course.slug}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center gap-3 rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground',
          isActive && 'bg-foreground/[0.05] font-medium text-foreground',
        )
      }
    >
      <span className="size-2.5 shrink-0 rounded-[4px]" style={coverDot(course.coverColor)} />
      <span className="truncate">{course.title}</span>
    </NavLink>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { data: session } = useSession();
  const me = session?.user;
  const { data: courses } = useQuery({
    queryKey: ['courses', 'mine'],
    queryFn: () => api.get<CourseSummary[]>('/courses/mine'),
    enabled: !!me,
  });
  const learning = (courses ?? []).filter((c) => c.myRole === 'student').slice(0, 6);
  const teaching = (courses ?? []).filter((c) => c.myRole && c.myRole !== 'student').slice(0, 6);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-4">
        <Link to="/" onClick={onNavigate} className="min-w-0">
          <Logo name={session?.site.name ?? 'Coursekit'} />
        </Link>
      </div>
      <nav className="ck-scrollbar flex-1 space-y-6 overflow-y-auto px-3 py-3">
        <div className="space-y-0.5">
          <NavItem to="/" end icon={LayoutDashboard} onNavigate={onNavigate}>
            Dashboard
          </NavItem>
          <NavItem to="/my-courses" icon={BookOpen} onNavigate={onNavigate}>
            My courses
          </NavItem>
          <NavItem to="/catalog" icon={Compass} onNavigate={onNavigate}>
            Explore
          </NavItem>
          <NavItem to="/calendar" icon={CalendarDays} onNavigate={onNavigate}>
            Calendar
          </NavItem>
        </div>
        {teaching.length > 0 && (
          <div>
            <p className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Teaching</p>
            <div className="space-y-0.5">
              {teaching.map((c) => (
                <CourseNavItem key={c.id} course={c} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        )}
        {learning.length > 0 && (
          <div>
            <p className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Learning</p>
            <div className="space-y-0.5">
              {learning.map((c) => (
                <CourseNavItem key={c.id} course={c} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        )}
        {me?.role === 'admin' && (
          <div>
            <p className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">Site</p>
            <NavItem to="/admin" icon={ShieldCheck} onNavigate={onNavigate}>
              Administration
            </NavItem>
          </div>
        )}
      </nav>
      <div className="space-y-3 border-t border-sidebar-border p-3">
        {canCreateCourses(me?.role) && (
          <Button asChild variant="outline" className="w-full justify-start" size="sm">
            <Link to="/courses/new" onClick={onNavigate}>
              <Plus /> New course
            </Link>
          </Button>
        )}
        {me && (
          <Link
            to="/profile"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-lg p-1.5 transition-colors hover:bg-foreground/[0.04]"
          >
            <Avatar user={me} size="sm" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{me.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{SITE_ROLE_LABELS[me.role]}</span>
            </span>
          </Link>
        )}
      </div>
    </div>
  );
}

const NOTIFICATION_ICONS: Record<string, LucideIcon> = {
  grade: Award,
  announcement: Megaphone,
  forum: MessageCircle,
  enrolment: UserPlus,
  completion: GraduationCap,
  badge: Medal,
};

export function NotificationIcon({ type }: { type: string }) {
  const Icon = NOTIFICATION_ICONS[type] ?? Bell;
  const tone =
    type === 'grade'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : type === 'announcement'
        ? 'bg-amber-500/12 text-amber-600 dark:text-amber-400'
        : type === 'forum'
          ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
          : 'bg-primary/10 text-primary';
  return (
    <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', tone)}>
      <Icon className="size-4" />
    </span>
  );
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: AppNotification[]; unreadCount: number }>('/notifications'),
    refetchInterval: 60_000,
  });
}

function NotificationsButton() {
  const { data } = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const unread = data?.unreadCount ?? 0;

  const markRead = async (ids?: string[]) => {
    await api.post('/notifications/read', ids ? { ids } : {});
    await qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
          <Bell className="size-[18px]" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground ring-2 ring-background">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          {unread > 0 && (
            <button className="text-xs font-medium text-primary hover:underline" onClick={() => markRead()}>
              Mark all as read
            </button>
          )}
        </div>
        <div className="ck-scrollbar max-h-96 overflow-y-auto">
          {(data?.items ?? []).slice(0, 8).map((n) => (
            <button
              key={n.id}
              className="flex w-full gap-3 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-accent/60"
              onClick={() => {
                setOpen(false);
                if (!n.readAt) void markRead([n.id]);
                if (n.link) navigate(n.link);
              }}
            >
              <NotificationIcon type={n.type} />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-sm leading-snug', !n.readAt && 'font-semibold')}>{n.title}</span>
                {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>}
                <span className="mt-1 block text-[11px] text-muted-foreground">{formatRelative(n.createdAt)}</span>
              </span>
              {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
            </button>
          ))}
          {data && data.items.length === 0 && <p className="px-4 py-10 text-center text-sm text-muted-foreground">You're all caught up.</p>}
        </div>
        <div className="border-t p-2">
          <Button asChild variant="ghost" size="sm" className="w-full" onClick={() => setOpen(false)}>
            <Link to="/notifications">View all notifications</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu() {
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();
  const setSession = useSetSession();
  const navigate = useNavigate();
  if (!me) return null;

  const signOut = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      const site = qc.getQueryData<SessionInfo>(['session']);
      qc.clear();
      if (site) setSession({ ...site, user: null, impersonator: null });
      navigate('/login');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded-full outline-offset-2" aria-label="Account menu">
          <Avatar user={me} size="sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <div className="px-2.5 py-2">
          <p className="truncate text-sm font-semibold">{me.name}</p>
          <p className="truncate text-xs text-muted-foreground">{me.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <UserIcon /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette /> Appearance
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuCheckItem checked={theme === 'light'} onSelect={() => setTheme('light')}>
              Light
            </DropdownMenuCheckItem>
            <DropdownMenuCheckItem checked={theme === 'dark'} onSelect={() => setTheme('dark')}>
              Dark
            </DropdownMenuCheckItem>
            <DropdownMenuCheckItem checked={theme === 'system'} onSelect={() => setTheme('system')}>
              System
            </DropdownMenuCheckItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {me.role === 'admin' && (
          <DropdownMenuItem asChild>
            <Link to="/admin">
              <ShieldCheck /> Administration
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ImpersonationBanner() {
  const { data } = useSession();
  const qc = useQueryClient();
  const setSession = useSetSession();
  const navigate = useNavigate();
  if (!data?.impersonator || !data.user) return null;
  const stop = async () => {
    try {
      const info = await api.post<SessionInfo>('/auth/stop-impersonating');
      qc.clear();
      setSession(info);
      navigate('/admin/users');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-400 px-4 py-2 text-center text-[13px] font-medium text-amber-950">
      <span className="flex items-center gap-2">
        <UserCog className="size-4" /> You're viewing the site as {data.user.name}.
      </span>
      <button onClick={stop} className="font-semibold underline underline-offset-2">
        Return to {data.impersonator.name}
      </button>
    </div>
  );
}

function ThemeToggle() {
  const { resolved, setTheme } = useTheme();
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}>
      {resolved === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </Button>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
        <SidebarContent />
      </aside>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <ImpersonationBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-lg sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu className="size-5" />
          </Button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg border bg-card px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:border-foreground/20 sm:max-w-sm"
          >
            <Search className="size-4 shrink-0" />
            <span className="truncate">Search courses and activities…</span>
            <span className="ml-auto hidden items-center gap-0.5 sm:flex">
              <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <NotificationsButton />
            <div className="ml-1.5">
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/** Standard page container. */
export function Page({
  children,
  className,
  size = 'default',
}: {
  children: ReactNode;
  className?: string;
  size?: 'default' | 'narrow' | 'wide';
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        size === 'default' && 'max-w-7xl',
        size === 'narrow' && 'max-w-3xl',
        size === 'wide' && 'max-w-[1600px]',
        className,
      )}
    >
      {children}
    </div>
  );
}
