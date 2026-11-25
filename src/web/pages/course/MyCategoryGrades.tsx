/**
 * A student's grades in a course that uses grade categories: one card per category with its
 * subtotal and weight, and a course total card that shows how the categories add up.
 */
import { Award } from 'lucide-react';
import { Link } from 'react-router';
import { categoriesWithItems } from '@shared/grades';
import type { MyGrades } from '@shared/types';
import { ActivityIcon } from '@/components/course';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState, Progress, ProgressRing } from '@/components/ui/misc';
import { activityPath } from '@/lib/activity';
import { formatPercent, formatWeight, gradeTone } from '@/lib/grades';
import { cn, formatDate, formatNumber, plural } from '@/lib/utils';

type Item = MyGrades['items'][number];
type Category = MyGrades['categories'][number];

function ItemRow({ item, courseSlug, category }: { item: Item; courseSlug: string; category: Category }) {
  const pct = item.score != null && item.maxGrade ? (item.score / item.maxGrade) * 100 : null;
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-3">
        <ActivityIcon type={item.type} />
        <div className="min-w-0 flex-1">
          <Link to={activityPath(courseSlug, item.activityId)} className="block truncate text-sm font-medium hover:text-primary">
            {item.title}
          </Link>
          <p className="text-xs text-muted-foreground">
            {item.gradedAt ? `Graded ${formatDate(item.gradedAt)}` : item.dueAt ? `Due ${formatDate(item.dueAt)}` : 'Not graded yet'}
          </p>
        </div>
        <div className="text-right">
          <p className={cn('text-sm font-semibold tabular-nums', item.dropped ? 'text-muted-foreground line-through' : gradeTone(pct))}>
            {item.score != null ? formatNumber(item.score) : '–'}{' '}
            <span className="font-normal text-muted-foreground">/ {formatNumber(item.maxGrade)}</span>
          </p>
          {item.dropped ? (
            <Badge variant="neutral" className="mt-1">
              Dropped
            </Badge>
          ) : (
            pct != null && <p className="text-xs text-muted-foreground tabular-nums">{formatNumber(pct)}%</p>
          )}
        </div>
      </div>
      {pct != null && !item.dropped && <Progress value={pct} className="mt-3" tone={pct >= 85 ? 'success' : 'primary'} />}
      {item.dropped && (
        <p className="mt-2 text-xs text-muted-foreground">
          Not counted: {category.name} leaves out your lowest {category.dropLowest === 1 ? 'grade' : `${category.dropLowest} grades`}, and
          this is {category.dropLowest === 1 ? 'it' : 'one of them'}.
        </p>
      )}
      {item.feedback && (
        <div className="mt-3 rounded-lg bg-muted/60 px-3.5 py-2.5 text-sm">
          <p className="mb-0.5 text-xs font-medium text-muted-foreground">Feedback</p>
          {item.feedback}
        </div>
      )}
    </div>
  );
}

function categoryMeta(c: Category, weighted: boolean) {
  const parts: string[] = [];
  if (weighted) parts.push(c.weight > 0 ? `${formatWeight(c.weight)} of the course total` : "Doesn't count towards the course total");
  else if (c.possible > 0) parts.push(`${formatNumber(c.earned, 2)} of ${formatNumber(c.possible, 2)} points`);
  if (c.dropLowest > 0) parts.push(`lowest ${c.dropLowest === 1 ? 'grade' : `${c.dropLowest} grades`} dropped`);
  return parts.join(' · ');
}

function Breakdown({ categories, weighted }: { categories: Category[]; weighted: boolean }) {
  const scaled = weighted && categories.some((c) => c.weight > 0 && c.share != null && Math.abs(c.share - c.weight) > 0.005);
  return (
    <div className="mt-5 border-t pt-4 text-left">
      <h3 className="text-xs font-medium text-muted-foreground">How your total adds up</h3>
      <ul className="mt-3 space-y-3">
        {categories.map((c) => (
          <li key={c.id}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{c.name}</span>
              <span className={cn('shrink-0 font-semibold tabular-nums', gradeTone(c.percentage))}>{formatPercent(c.percentage)}</span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
              <span>{weighted ? `Weight ${formatWeight(c.weight)}` : `${formatNumber(c.possible, 2)} points so far`}</span>
              <span className="tabular-nums">{c.share != null ? `counts ${formatPercent(c.share)}` : 'not counted yet'}</span>
            </div>
            <Progress value={c.share ?? 0} className="mt-1.5 h-1" />
          </li>
        ))}
      </ul>
      {scaled && (
        <p className="mt-3 text-xs text-muted-foreground">
          Categories without grades yet don't count, so the others are scaled up to make 100%. This changes as more work is graded.
        </p>
      )}
    </div>
  );
}

export function MyCategoryGrades({ grades, courseSlug }: { grades: MyGrades; courseSlug: string }) {
  if (grades.items.length === 0) {
    return <EmptyState icon={Award} title="Nothing graded yet" description="Grades for assignments and quizzes will show up here." />;
  }
  const weighted = grades.aggregation === 'weighted';
  const groups = categoriesWithItems(grades.categories, grades.items);
  // Weighted courses also list categories that have no activities yet, so students see every weight.
  const breakdown = weighted ? grades.categories.filter((c) => c.weight > 0 || groups.some((g) => g.id === c.id)) : groups;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-5">
        {groups.map((g) => (
          <Card key={g.id} className="overflow-hidden">
            <section aria-labelledby={`grade-category-${g.id}`}>
              <div className="flex items-center gap-4 border-b bg-muted/30 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <h2 id={`grade-category-${g.id}`} className="truncate text-sm font-semibold">
                    {g.name}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {categoryMeta(g, weighted) || plural(g.itemCount, 'activity', 'activities')}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={cn('text-sm font-semibold tabular-nums', gradeTone(g.percentage))}>{formatPercent(g.percentage)}</p>
                  <p className="text-xs text-muted-foreground">{g.percentage == null ? 'Nothing graded yet' : 'Subtotal'}</p>
                </div>
              </div>
              <div className="divide-y">
                {grades.items
                  .filter((item) => item.categoryId === g.id)
                  .map((item) => (
                    <ItemRow key={item.activityId} item={item} courseSlug={courseSlug} category={g} />
                  ))}
              </div>
            </section>
          </Card>
        ))}
      </div>
      <Card className="p-5 text-center lg:sticky lg:top-32">
        <p className="text-sm font-medium text-muted-foreground">Course total</p>
        <ProgressRing
          value={grades.percentage ?? 0}
          size={120}
          stroke={9}
          className="mx-auto mt-4 text-primary"
          label={<span className="text-2xl font-semibold">{formatPercent(grades.percentage)}</span>}
        />
        <p className="mt-4 text-sm">
          {weighted ? 'Weighted by category' : `${formatNumber(grades.total)} of ${formatNumber(grades.max)} points`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Based on graded work so far.</p>
        {grades.percentage != null && (
          <Badge variant={grades.percentage >= 85 ? 'success' : grades.percentage >= 60 ? 'info' : 'warning'} className="mt-3">
            {grades.percentage >= 85 ? 'Excellent work' : grades.percentage >= 60 ? 'On track' : 'Needs attention'}
          </Badge>
        )}
        <Breakdown categories={breakdown} weighted={weighted} />
      </Card>
    </div>
  );
}
