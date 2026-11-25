/**
 * Category additions to the gradebook table: a header row that groups item columns by category,
 * a subtotal column per category (placed just before the course total) and their averages.
 * Each piece renders nothing when the course doesn't use categories, so the table looks as before.
 */
import { SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import type { Gradebook, GradebookRow } from '@shared/types';
import { Button } from '@/components/ui/button';
import { formatPercent, formatWeight, gradebookGroups, gradeTone } from '@/lib/grades';
import { cn } from '@/lib/utils';
import { useCourseContext } from './context';

function subtotalHint(book: Gradebook, weight: number, dropLowest: number) {
  const parts = [book.aggregation === 'weighted' ? `${formatWeight(weight)} of total` : 'Subtotal'];
  if (dropLowest > 0) parts.push(`drops lowest ${dropLowest}`);
  return parts.join(' · ');
}

/** First header row: one cell per category spanning its items, then one spanning the subtotals. */
export function CategoryGroupRow({ book }: { book: Gradebook }) {
  const groups = gradebookGroups(book);
  if (groups.length === 0) return null;
  const weighted = book.aggregation === 'weighted';
  return (
    <tr className="text-left text-xs">
      <td className="sticky left-0 z-10 bg-card" />
      {groups.map((g) => (
        <th key={g.id} scope="colgroup" colSpan={g.itemCount} className="px-1.5 pt-3 font-medium" title={g.name}>
          <span className="flex items-baseline gap-2 border-b-2 border-primary/35 px-1.5 pb-1.5">
            <span className="truncate text-foreground">{g.name}</span>
            {weighted && <span className="ml-auto shrink-0 font-normal text-muted-foreground tabular-nums">{formatWeight(g.weight)}</span>}
          </span>
        </th>
      ))}
      <th scope="colgroup" colSpan={groups.length} className="px-1.5 pt-3 font-medium">
        <span className="block border-b-2 border-foreground/20 px-1.5 pb-1.5 text-foreground">Category totals</span>
      </th>
      <td className="bg-muted/40" />
    </tr>
  );
}

export function CategoryTotalHeaders({ book }: { book: Gradebook }) {
  return (
    <>
      {gradebookGroups(book).map((g) => (
        <th key={g.id} scope="col" className="min-w-28 border-b px-3 py-3 text-right align-bottom font-medium">
          <span className="line-clamp-2 text-foreground">{g.name}</span>
          <span className="mt-1.5 block font-normal">{subtotalHint(book, g.weight, g.dropLowest)}</span>
        </th>
      ))}
    </>
  );
}

export function CategoryTotalCells({ book, row }: { book: Gradebook; row: GradebookRow }) {
  return (
    <>
      {gradebookGroups(book).map((g) => {
        const pct = row.categories[g.id]?.percentage ?? null;
        return (
          <td key={g.id} className="border-b px-3 py-2.5 text-right group-hover:bg-accent/40">
            <span className={cn('font-medium tabular-nums', gradeTone(pct))}>{formatPercent(pct)}</span>
          </td>
        );
      })}
    </>
  );
}

export function CategoryAverageCells({ book }: { book: Gradebook }) {
  return (
    <>
      {gradebookGroups(book).map((g) => (
        <td key={g.id} className="bg-muted/60 px-3 py-3 text-right tabular-nums">
          {formatPercent(book.categoryAverages[g.id])}
        </td>
      ))}
    </>
  );
}

/** Link to the gradebook setup, for people who may change it. */
export function GradebookSetupButton({ courseSlug }: { courseSlug: string }) {
  const { can } = useCourseContext();
  if (!can('grades:manage')) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <Link to={`/courses/${courseSlug}/grades/setup`} aria-label="Categories and weights">
        <SlidersHorizontal />
        <span className="hidden sm:inline">Categories &amp; weights</span>
      </Link>
    </Button>
  );
}
