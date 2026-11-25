import { Contact, FolderTree, LayoutDashboard, Library, Mail, Medal, Settings, Users } from 'lucide-react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { PageHeader } from '@/components/common';
import { Page } from '@/components/layout/shell';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/cohorts', label: 'Cohorts', icon: Contact },
  { to: '/admin/courses', label: 'Courses', icon: Library },
  { to: '/admin/categories', label: 'Categories', icon: FolderTree },
  { to: '/admin/settings', label: 'Site settings', icon: Settings },
  { to: '/admin/email', label: 'Email', icon: Mail },
  { to: '/admin/badges', label: 'Badges', icon: Medal },
];

export default function AdminLayout() {
  const me = useMe();
  if (me?.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <Page>
      <PageHeader title="Administration" description="Manage people, courses and how your site looks." />
      <nav className="ck-no-scrollbar mb-7 flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              cn(
                'relative -mb-px flex h-10 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                isActive && 'border-primary text-foreground',
              )
            }
          >
            <t.icon className="size-4" />
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </Page>
  );
}
