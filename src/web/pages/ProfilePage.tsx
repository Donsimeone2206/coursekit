import { useMutation } from '@tanstack/react-query';
import { Camera, KeyRound, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { SITE_ROLE_LABELS } from '@shared/permissions';
import type { SessionInfo } from '@shared/types';
import { PageHeader } from '@/components/common';
import { EmailPreferencesCard } from '@/components/email/EmailPreferencesCard';
import { MyAchievements } from '@/components/completion/my-achievements';
import { Page } from '@/components/layout/shell';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ChoiceCards, Field, Input, Textarea } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useTitle } from '@/lib/hooks';
import { useMe, useSetSession } from '@/lib/session';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { formatDate } from '@/lib/utils';

export default function ProfilePage() {
  useTitle('Profile');
  const me = useMe()!;
  const setSession = useSetSession();
  const { theme, setTheme } = useTheme();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(me.name);
  const [bio, setBio] = useState(me.bio ?? '');
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });

  const saveProfile = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<SessionInfo>('/auth/me', body),
    onSuccess: (info) => {
      setSession(info);
      toast.success('Profile updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const changePassword = useMutation({
    mutationFn: () => api.post('/auth/me/password', passwords),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '' });
      toast.success('Password changed. Other devices have been signed out.');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const uploadAvatar = async (file: File) => {
    try {
      const uploaded = await api.upload(file, { context: 'avatar' });
      saveProfile.mutate({ avatarUrl: uploaded.url });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page size="narrow">
      <PageHeader title="Profile" description="How you appear to teachers and classmates." />
      <div className="space-y-6">
        <Card>
          <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center">
            <div className="relative">
              <Avatar user={me} size="xl" />
              <button
                onClick={() => fileInput.current?.click()}
                className="absolute -right-1 -bottom-1 grid size-8 place-items-center rounded-full border bg-card shadow-sm transition-colors hover:bg-accent"
                aria-label="Change photo"
              >
                <Camera className="size-4" />
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAvatar(f);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold">{me.name}</p>
              <p className="text-sm text-muted-foreground">{me.email}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="default">{SITE_ROLE_LABELS[me.role]}</Badge>
                <span className="text-xs text-muted-foreground">Member since {formatDate(me.createdAt, { year: 'numeric' })}</span>
              </div>
            </div>
            {me.avatarUrl && (
              <Button variant="ghost" size="sm" onClick={() => saveProfile.mutate({ avatarUrl: null })}>
                <Trash2 /> Remove photo
              </Button>
            )}
          </div>
          <form
            className="space-y-4 border-t p-6"
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate({ name, bio: bio.trim() || null });
            }}
          >
            <Field label="Full name">{(p) => <Input {...p} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="About you" optional hint="A sentence or two for your classmates.">
              {(p) => <Textarea {...p} rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={saveProfile.isPending} disabled={name === me.name && bio === (me.bio ?? '')}>
                Save profile
              </Button>
            </div>
          </form>
        </Card>
        <MyAchievements />

        <Card>
          <CardHeader title="Appearance" description="Choose how the site looks on this device." />
          <div className="px-5 pb-5">
            <ChoiceCards<ThemePreference>
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: 'Light', icon: <Sun className="size-4" /> },
                { value: 'dark', label: 'Dark', icon: <Moon className="size-4" /> },
                { value: 'system', label: 'System', description: 'Match your device', icon: <Monitor className="size-4" /> },
              ]}
            />
          </div>
        </Card>

        <EmailPreferencesCard />

        <Card>
          <CardHeader
            title="Password"
            description="Changing your password signs you out on other devices."
            icon={<KeyRound className="size-4.5" />}
          />
          <form
            className="grid gap-4 px-5 pb-5 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              changePassword.mutate();
            }}
          >
            <Field label="Current password">
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="current-password"
                  value={passwords.currentPassword}
                  onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
                />
              )}
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={passwords.newPassword}
                  onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
                />
              )}
            </Field>
            <div className="flex justify-end sm:col-span-2">
              <Button type="submit" variant="outline" loading={changePassword.isPending} disabled={passwords.newPassword.length < 8}>
                Change password
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </Page>
  );
}
