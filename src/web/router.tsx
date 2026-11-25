import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation, useRouteError } from 'react-router';
import { AppShell } from './components/layout/shell';
import { Button } from './components/ui/button';
import { PageLoader } from './components/ui/misc';
import { errorMessage } from './lib/api';
import { useSession } from './lib/session';
import { reloadForNewVersion, waitForReload } from './lib/stale';
import { LoginPage, RegisterPage, SetupPage } from './pages/auth/AuthPages';
import DashboardPage from './pages/DashboardPage';

/** Route-level code splitting: each page loads on first visit. */
function page<M extends Record<string, unknown>>(factory: () => Promise<M>, name: keyof M = 'default') {
  const Component = lazy(async () => {
    try {
      return { default: (await factory())[name] as ComponentType };
    } catch (err) {
      // The page file belongs to an older build that is gone: load the new build instead of failing.
      // (Vite's preload errors arrive here too: nothing calls preventDefault on `vite:preloadError`.)
      if (reloadForNewVersion()) return waitForReload(err);
      throw err;
    }
  });
  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useSession();
  const location = useLocation();
  if (isLoading) return <PageLoader />;
  if (error) return <RouteError />;
  if (data?.needsSetup) return <Navigate to="/setup" replace />;
  if (!data?.user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

function RouteError() {
  const error = useRouteError();
  return (
    <div className="grid min-h-dvh place-items-center p-6 text-center">
      <div>
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error ? errorMessage(error) : 'We could not reach the server.'}</p>
        <Button className="mt-6" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/setup', element: <SetupPage />, errorElement: <RouteError /> },
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/register', element: <RegisterPage />, errorElement: <RouteError /> },
  { path: '/unsubscribe', element: page(() => import('./pages/UnsubscribePage')), errorElement: <RouteError /> },
  { path: '/verify/:code?', element: page(() => import('./pages/VerifyCertificatePage')), errorElement: <RouteError /> },
  {
    path: '/certificates/:certificateId',
    element: <RequireAuth>{page(() => import('./pages/CertificatePage'))}</RequireAuth>,
    errorElement: <RouteError />,
  },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'my-courses', element: page(() => import('./pages/MyCoursesPage')) },
      { path: 'catalog', element: page(() => import('./pages/CatalogPage')) },
      { path: 'calendar', element: page(() => import('./pages/CalendarPage')) },
      { path: 'notifications', element: page(() => import('./pages/NotificationsPage')) },
      { path: 'profile', element: page(() => import('./pages/ProfilePage')) },
      { path: 'courses/new', element: page(() => import('./pages/course/CreateCoursePage')) },
      {
        path: 'courses/:slug',
        element: page(() => import('./pages/course/CourseLayout')),
        children: [
          { index: true, element: page(() => import('./pages/course/CourseContentPage')) },
          { path: 'announcements', element: page(() => import('./pages/course/AnnouncementsPage')) },
          { path: 'participants', element: page(() => import('./pages/course/ParticipantsPage')) },
          { path: 'groups', element: page(() => import('./pages/course/GroupsPage')) },
          { path: 'grades', element: page(() => import('./pages/course/GradesPage')) },
          { path: 'completion', element: page(() => import('./pages/course/CompletionPage')) },
          { path: 'badges', element: page(() => import('./pages/course/CourseBadgesPage')) },
          { path: 'grades/setup', element: page(() => import('./pages/course/GradebookSetupPage')) },
          { path: 'settings', element: page(() => import('./pages/course/CourseSettingsPage')) },
          { path: 'question-bank', element: page(() => import('./pages/course/QuestionBankPage')) },
        ],
      },
      { path: 'courses/:slug/activities/:activityId', element: page(() => import('./pages/activities/ActivityPage')) },
      { path: 'courses/:slug/activities/:activityId/submissions', element: page(() => import('./pages/activities/SubmissionsPage')) },
      { path: 'courses/:slug/activities/:activityId/questions', element: page(() => import('./pages/activities/QuizEditorPage')) },
      { path: 'courses/:slug/attempts/:attemptId', element: page(() => import('./pages/activities/QuizAttemptPage')) },
      { path: 'courses/:slug/discussions/:discussionId', element: page(() => import('./pages/activities/DiscussionPage')) },
      { path: 'badges/:badgeId', element: page(() => import('./pages/BadgePage')) },
      {
        path: 'admin',
        element: page(() => import('./pages/admin/AdminLayout')),
        children: [
          { index: true, element: page(() => import('./pages/admin/AdminOverviewPage')) },
          { path: 'users', element: page(() => import('./pages/admin/AdminUsersPage')) },
          { path: 'cohorts', element: page(() => import('./pages/admin/AdminCohortsPage'), 'AdminCohortsPage') },
          { path: 'cohorts/:cohortId', element: page(() => import('./pages/admin/AdminCohortsPage'), 'AdminCohortPage') },
          { path: 'courses', element: page(() => import('./pages/admin/AdminCoursesPage'), 'AdminCoursesPage') },
          { path: 'categories', element: page(() => import('./pages/admin/AdminCoursesPage'), 'AdminCategoriesPage') },
          { path: 'settings', element: page(() => import('./pages/admin/AdminSettingsPage')) },
          { path: 'email', element: page(() => import('./pages/admin/AdminEmailPage')) },
          { path: 'badges', element: page(() => import('./pages/admin/AdminBadgesPage')) },
        ],
      },
      { path: '*', element: page(() => import('./pages/NotFoundPage')) },
    ],
  },
]);
