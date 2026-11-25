import { useMutation } from '@tanstack/react-query';
import { CalendarClock, CircleCheck, ClipboardCheck, Clock, FileText, MessageSquareText, Pencil, Send, Upload, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { ActivityDetail, AssignmentSettings, FileInfo } from '@shared/types';
import { FileChip, FileDrop } from '@/components/common';
import { Markdown, MarkdownEditor } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Label } from '@/components/ui/form';
import { Progress } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { api, errorMessage } from '@/lib/api';
import { useNow } from '@/lib/hooks';
import { cn, formatDateTime, formatNumber, formatRelative, isPast } from '@/lib/utils';
import { useInvalidateCourse } from '../course/context';
import { ActivityFrame } from './frame';

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3 text-sm first:pt-0 last:pb-0">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 font-medium">{children}</span>
    </div>
  );
}

function TimeLeft({ dueAt }: { dueAt: string }) {
  const now = useNow(30_000);
  const diff = new Date(dueAt).getTime() - now;
  if (diff <= 0) return <span className="text-destructive">Past due</span>;
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return (
    <span className={cn(diff < 86_400_000 && 'text-amber-600 dark:text-amber-400')}>
      {days > 0 ? `${days}d ${hours}h left` : `${hours}h ${minutes}m left`}
    </span>
  );
}

function SubmissionPanel({ activity }: { activity: ActivityDetail<'assignment'> }) {
  const settings = activity.settings as AssignmentSettings;
  const submission = activity.submission ?? null;
  const invalidate = useInvalidateCourse();
  const [editing, setEditing] = useState(!submission);
  const [text, setText] = useState(submission?.text ?? '');
  const [files, setFiles] = useState<FileInfo[]>(submission?.files ?? []);
  const closed = !!activity.dueAt && isPast(activity.dueAt) && !settings.allowLate;
  const allowText = settings.submissionTypes.includes('text');
  const allowFiles = settings.submissionTypes.includes('file');

  const submit = useMutation({
    mutationFn: () => api.put(`/activities/${activity.id}/submission`, { text: allowText ? text : null, fileIds: files.map((f) => f.id) }),
    onSuccess: async () => {
      toast.success(submission ? 'Submission updated' : 'Submitted! Your teacher will review it soon.');
      setEditing(false);
      await invalidate(activity.course.slug);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (submission && !editing) {
    return (
      <Card>
        <CardHeader
          title="Your submission"
          description={
            <span className="flex items-center gap-2">
              Submitted {formatRelative(submission.submittedAt)}
              {submission.late && <Badge variant="warning">Late</Badge>}
            </span>
          }
          icon={<CircleCheck className="size-4.5 text-success" />}
          action={
            !closed && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setText(submission.text ?? '');
                  setFiles(submission.files);
                  setEditing(true);
                }}
              >
                <Pencil /> Edit submission
              </Button>
            )
          }
        />
        <div className="space-y-4 px-5 pb-5">
          {submission.text && (
            <div className="rounded-lg border bg-muted/30 p-4">
              <Markdown source={submission.text} className="prose-sm" />
            </div>
          )}
          {submission.files.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {submission.files.map((f) => (
                <FileChip key={f.id} file={f} />
              ))}
            </div>
          )}
        </div>
      </Card>
    );
  }

  if (closed && !submission) {
    return (
      <Card className="p-6 text-center">
        <Clock className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-2 font-medium">Submissions are closed</p>
        <p className="mt-1 text-sm text-muted-foreground">The due date has passed and this assignment doesn't accept late work.</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={submission ? 'Edit your submission' : 'Submit your work'}
        description={submission ? 'Your previous submission will be replaced.' : undefined}
        icon={<Upload className="size-4.5" />}
      />
      <form
        className="space-y-5 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        {allowText && (
          <div className="space-y-1.5">
            <Label>Online text</Label>
            <MarkdownEditor value={text} onChange={setText} rows={8} placeholder="Write your answer, or paste a link to your work…" />
          </div>
        )}
        {allowFiles && (
          <div className="space-y-2">
            <Label>
              Files{' '}
              <span className="font-normal text-muted-foreground">
                ({files.length}/{settings.maxFiles})
              </span>
            </Label>
            {files.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {files.map((f) => (
                  <FileChip key={f.id} file={f} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />
                ))}
              </div>
            )}
            {files.length < settings.maxFiles && (
              <FileDrop
                context="submission"
                courseId={activity.course.id}
                multiple
                onUploaded={(f) => setFiles((prev) => [...prev, f].slice(0, settings.maxFiles))}
              />
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {submission && (
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={submit.isPending} disabled={!text.trim() && files.length === 0}>
            <Send /> {submission ? 'Update submission' : 'Submit assignment'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AssignmentView({ activity }: { activity: ActivityDetail<'assignment'> }) {
  const settings = activity.settings as AssignmentSettings;
  const isStudent = activity.capabilities.includes('assignment:submit');
  const isStaff = activity.capabilities.includes('grades:viewAll');
  const grade = activity.grade;
  const stats = activity.submissionStats;
  const graded = grade?.score != null;
  const status = graded ? 'Graded' : activity.submission ? (activity.submission.late ? 'Submitted late' : 'Submitted') : 'Not submitted';

  return (
    <ActivityFrame activity={activity}>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-6">
          {graded && isStudent && (
            <Card className="overflow-hidden border-success/30">
              <div className="flex items-center gap-4 bg-success/[0.06] px-5 py-4">
                <span className="grid size-12 place-items-center rounded-full bg-success text-white">
                  <CircleCheck className="size-6" />
                </span>
                <div className="flex-1">
                  <p className="text-sm text-muted-foreground">Your grade</p>
                  <p className="text-2xl font-semibold tabular-nums">
                    {formatNumber(grade!.score)}{' '}
                    <span className="text-base font-normal text-muted-foreground">/ {formatNumber(grade!.maxGrade)}</span>
                  </p>
                </div>
                <span className="text-2xl font-semibold text-success tabular-nums">
                  {Math.round((grade!.score! / (grade!.maxGrade || 1)) * 100)}%
                </span>
              </div>
              {grade!.feedback && (
                <div className="flex gap-3 border-t px-5 py-4">
                  {grade!.gradedBy ? (
                    <Avatar user={grade!.gradedBy} size="sm" />
                  ) : (
                    <MessageSquareText className="size-5 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {grade!.gradedBy?.name ?? 'Feedback'}{' '}
                      <span className="font-normal text-muted-foreground">· {formatRelative(grade!.gradedAt)}</span>
                    </p>
                    <p className="mt-1 text-sm whitespace-pre-wrap">{grade!.feedback}</p>
                  </div>
                </div>
              )}
            </Card>
          )}
          <Card className="p-6 sm:p-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <FileText className="size-4" /> Instructions
            </h2>
            {activity.description.trim() ? (
              <Markdown source={activity.description} />
            ) : (
              <p className="text-muted-foreground">No instructions provided.</p>
            )}
          </Card>
          {isStudent && <SubmissionPanel activity={activity} />}
        </div>

        <div className="space-y-5 lg:sticky lg:top-20">
          {isStudent && (
            <Card className="p-5">
              <Row icon={<CalendarClock />} label="Due">
                {activity.dueAt ? formatDateTime(activity.dueAt) : 'No due date'}
              </Row>
              {activity.dueAt && !activity.submission && (
                <Row icon={<Clock />} label="Time left">
                  <TimeLeft dueAt={activity.dueAt} />
                </Row>
              )}
              <Row icon={<Upload />} label="Status">
                <Badge variant={graded ? 'success' : activity.submission ? 'info' : 'neutral'}>{status}</Badge>
              </Row>
              <Row icon={<ClipboardCheck />} label="Grade">
                {graded ? (
                  `${formatNumber(grade!.score)} / ${formatNumber(grade!.maxGrade)}`
                ) : (
                  <span className="text-muted-foreground">Not graded yet</span>
                )}
              </Row>
              <div className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                Accepts{' '}
                {settings.submissionTypes.map((t) => (t === 'text' ? 'online text' : `up to ${settings.maxFiles} files`)).join(' and ')}.
                {settings.allowLate ? ' Late work is accepted.' : ' Late work is not accepted.'}
              </div>
            </Card>
          )}
          {isStaff && stats && (
            <Card className="p-5">
              <p className="text-sm font-semibold">Submissions</p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                {[
                  ['Students', stats.participants],
                  ['Submitted', stats.submitted],
                  ['To grade', stats.needsGrading],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-muted/60 px-2 py-3">
                    <p className="text-xl font-semibold tabular-nums">{value}</p>
                    <p className="text-[11px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
              <Progress value={stats.participants ? (stats.submitted / stats.participants) * 100 : 0} className="mt-4" />
              <Button asChild className="mt-4 w-full">
                <Link to={`${activityPath(activity.course.slug, activity.id)}/submissions`}>
                  <Users />{' '}
                  {stats.needsGrading ? `Grade ${stats.needsGrading} submission${stats.needsGrading === 1 ? '' : 's'}` : 'View submissions'}
                </Link>
              </Button>
            </Card>
          )}
        </div>
      </div>
    </ActivityFrame>
  );
}
