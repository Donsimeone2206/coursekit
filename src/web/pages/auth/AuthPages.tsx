import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Award,
  BookOpen,
  Check,
  ClipboardCheck,
  Eye,
  EyeOff,
  ListChecks,
  MessagesSquare,
  Rocket,
  Sparkles,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import type { SessionInfo } from '@shared/types';
import { Logo } from '@/components/layout/shell';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { PageLoader, Progress } from '@/components/ui/misc';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useSession, useSetSession } from '@/lib/session';
import { cn } from '@/lib/utils';

function BrandPanel({ tagline }: { tagline: string }) {
  const features = [
    { icon: BookOpen, title: 'Courses that flow', text: 'Lessons, files and links organised into clear sections.' },
    { icon: ClipboardCheck, title: 'Assignments with feedback', text: 'Collect work, grade it and reply in one place.' },
    { icon: ListChecks, title: 'Auto-graded quizzes', text: 'Five question types, timers, attempts and review.' },
    { icon: MessagesSquare, title: 'Discussions', text: 'Forums and announcements keep everyone in the loop.' },
  ];
  return (
    <div
      className="relative hidden overflow-hidden lg:block"
      style={{
        backgroundImage: 'linear-gradient(150deg, var(--brand-light) 0%, color-mix(in oklab, var(--brand-light) 55%, #0b0d1a) 100%)',
      }}
    >
      <div
        className="absolute inset-0 opacity-40"
        style={{ backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.18) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      />
      <div className="absolute -top-32 -right-24 size-[28rem] rounded-full bg-white/15 blur-3xl" />
      <div className="absolute -bottom-40 -left-20 size-[26rem] rounded-full bg-black/20 blur-3xl" />
      <div className="relative flex h-full flex-col justify-between p-12 text-white xl:p-16">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-medium backdrop-blur">
            <Sparkles className="size-3.5" /> Open-source learning platform
          </span>
          <h2 className="mt-6 max-w-md text-4xl leading-[1.1] font-semibold tracking-tight text-balance xl:text-5xl">{tagline}</h2>
        </div>

        <div className="relative my-10 max-w-md">
          <div className="rounded-2xl bg-white/95 p-5 text-slate-900 shadow-2xl shadow-black/30">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500 text-white">
                <BookOpen className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Modern Web Development</p>
                <p className="text-xs text-slate-500">Next: State and effects · 15 min</p>
              </div>
              <span className="text-sm font-semibold text-indigo-600">72%</span>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full w-[72%] rounded-full bg-indigo-500" />
            </div>
          </div>
          <div className="absolute -right-6 -bottom-8 flex items-center gap-3 rounded-xl bg-white p-3 pr-4 text-slate-900 shadow-xl shadow-black/25">
            <span className="grid size-9 place-items-center rounded-full bg-emerald-100 text-emerald-600">
              <Award className="size-4.5" />
            </span>
            <div>
              <p className="text-xs font-semibold">Quiz graded</p>
              <p className="text-xs text-slate-500">You scored 9 / 10</p>
            </div>
          </div>
        </div>

        <div className="grid max-w-lg grid-cols-2 gap-x-6 gap-y-5">
          {features.map((f) => (
            <div key={f.title} className="flex gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/15">
                <f.icon className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold">{f.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-white/75">{f.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AuthLayout({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  const { data } = useSession();
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-6 py-7 sm:px-12">
        <Logo name={data?.site.name ?? 'Coursekit'} />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
        <p className="text-xs text-muted-foreground">
          Powered by <span className="font-medium text-foreground">Coursekit</span> {data?.version && `v${data.version}`}
        </p>
      </div>
      <BrandPanel tagline={data?.site.tagline ?? 'Learn anything, together.'} />
    </div>
  );
}

function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} className="pr-10" {...props} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function issueFor(error: unknown, path: string) {
  return error instanceof ApiError ? error.issues.find((i) => i.path === path)?.message : undefined;
}

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
      {errorMessage(error)}
    </div>
  );
}

/** Where to go after signing in: the `next` parameter if it is a safe same-site path. */
function useNextPath() {
  const [params] = useSearchParams();
  const next = params.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function useAuthSuccess() {
  const qc = useQueryClient();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const next = useNextPath();
  return (info: SessionInfo) => {
    qc.clear();
    setSession(info);
    navigate(next, { replace: true });
  };
}

export function LoginPage() {
  useTitle('Sign in');
  const { data, isLoading } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const onSuccess = useAuthSuccess();
  const login = useMutation({ mutationFn: () => api.post<SessionInfo>('/auth/login', { email, password }), onSuccess });
  const next = useNextPath();

  if (isLoading) return <PageLoader />;
  if (data?.needsSetup) return <Navigate to="/setup" replace />;
  if (data?.user) return <Navigate to={next} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthLayout title="Welcome back" subtitle={`Sign in to continue to ${data?.site.name ?? 'Coursekit'}.`}>
      <form onSubmit={submit} className="space-y-4">
        <FormError error={login.error} />
        <Field label="Email">
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@school.edu"
            />
          )}
        </Field>
        <Field label="Password">
          {(p) => (
            <PasswordInput {...p} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
      {data?.site.allowSignup && (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </p>
      )}
    </AuthLayout>
  );
}

export function RegisterPage() {
  useTitle('Create account');
  const { data, isLoading } = useSession();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const onSuccess = useAuthSuccess();
  const register = useMutation({ mutationFn: () => api.post<SessionInfo>('/auth/register', form), onSuccess });
  const next = useNextPath();

  if (isLoading) return <PageLoader />;
  if (data?.needsSetup) return <Navigate to="/setup" replace />;
  if (data?.user) return <Navigate to={next} replace />;
  if (data && !data.site.allowSignup) {
    return (
      <AuthLayout title="Registration is closed" subtitle="Ask your administrator to create an account for you.">
        <Button asChild variant="outline" className="w-full">
          <Link to="/login">
            <ArrowLeft /> Back to sign in
          </Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your account" subtitle="Start learning in less than a minute.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          register.mutate();
        }}
        className="space-y-4"
      >
        <FormError
          error={register.error && !issueFor(register.error, 'email') && !issueFor(register.error, 'password') ? register.error : null}
        />
        <Field label="Full name" error={issueFor(register.error, 'name')}>
          {(p) => (
            <Input
              {...p}
              autoComplete="name"
              autoFocus
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Email" error={issueFor(register.error, 'email')}>
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          )}
        </Field>
        <Field label="Password" hint="At least 8 characters." error={issueFor(register.error, 'password')}>
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={register.isPending}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function SetupPage() {
  useTitle('Set up');
  const { data, isLoading } = useSession();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ siteName: 'Coursekit Academy', name: '', email: '', password: '', demo: true });
  const onSuccess = useAuthSuccess();
  const setup = useMutation({ mutationFn: () => api.post<SessionInfo>('/auth/setup', form), onSuccess });

  if (isLoading) return <PageLoader />;
  if (data && !data.needsSetup) return <Navigate to={data.user ? '/' : '/login'} replace />;

  const steps = ['Your site', 'Admin account', 'Get started'];
  const canContinue =
    step === 0 ? form.siteName.trim().length > 0 : step === 1 ? form.name && form.email.includes('@') && form.password.length >= 8 : true;

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (step < 2) setStep(step + 1);
    else setup.mutate();
  };

  return (
    <AuthLayout
      title={step === 0 ? 'Welcome to Coursekit 🎉' : step === 1 ? 'Create the administrator' : 'How would you like to start?'}
      subtitle={
        step === 0
          ? "Let's set up your learning platform. It takes about a minute."
          : step === 1
            ? 'This account can manage the whole site. You can add more people later.'
            : 'You can always remove demo content later by deleting the demo courses.'
      }
    >
      <div className="mb-6 space-y-2">
        <div className="flex justify-between text-xs font-medium text-muted-foreground">
          {steps.map((s, i) => (
            <span key={s} className={cn(i <= step && 'text-foreground')}>
              {i + 1}. {s}
            </span>
          ))}
        </div>
        <Progress value={((step + 1) / steps.length) * 100} />
      </div>
      <form onSubmit={next} className="space-y-4">
        <FormError error={setup.error} />
        {step === 0 && (
          <Field label="Site name" hint="Shown in the sidebar, emails and browser tabs.">
            {(p) => <Input {...p} autoFocus value={form.siteName} onChange={(e) => setForm({ ...form, siteName: e.target.value })} />}
          </Field>
        )}
        {step === 1 && (
          <>
            <Field label="Your name">
              {(p) => (
                <Input
                  {...p}
                  autoFocus
                  autoComplete="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </Field>
            <Field label="Email">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              )}
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              {(p) => (
                <PasswordInput
                  {...p}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              )}
            </Field>
          </>
        )}
        {step === 2 && (
          <div className="grid gap-3">
            {[
              {
                demo: true,
                icon: Sparkles,
                title: 'Explore with demo content',
                text: 'Six sample courses with teachers, students, quizzes, grades and discussions.',
              },
              { demo: false, icon: Rocket, title: 'Start fresh', text: 'An empty site, ready for your first course.' },
            ].map((o) => (
              <button
                key={o.title}
                type="button"
                onClick={() => setForm({ ...form, demo: o.demo })}
                className={cn(
                  'flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/40',
                  form.demo === o.demo && 'border-primary ring-3 ring-primary/10',
                )}
              >
                <span
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-lg bg-muted',
                    form.demo === o.demo && 'bg-primary/10 text-primary',
                  )}
                >
                  <o.icon className="size-4.5" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{o.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{o.text}</span>
                </span>
                {form.demo === o.demo && <Check className="size-4 text-primary" />}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          {step > 0 && (
            <Button type="button" variant="outline" size="lg" onClick={() => setStep(step - 1)}>
              <ArrowLeft />
            </Button>
          )}
          <Button type="submit" size="lg" className="flex-1" disabled={!canContinue} loading={setup.isPending}>
            {step < 2 ? (
              <>
                Continue <ArrowRight />
              </>
            ) : (
              <>
                Launch my site <Rocket />
              </>
            )}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
