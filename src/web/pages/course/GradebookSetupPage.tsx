import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Award, CircleAlert, CircleCheck, Lock, Plus, Scale, Sigma, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { GradeAggregation, GradebookSetup, GradebookSetupInput, GradeItemSetting } from '@shared/types';
import { ActivityIcon } from '@/components/course';
import { Page } from '@/components/layout/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChoiceCards, Input, Select } from '@/components/ui/form';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { formatPercent, formatWeight } from '@/lib/grades';
import { useTitle, useUnsavedChanges } from '@/lib/hooks';
import { cn, formatNumber, plural } from '@/lib/utils';
import { useCourseContext } from './context';

interface DraftCategory {
  id: string;
  name: string;
  weight: string;
  dropLowest: string;
  isDefault: boolean;
}

interface Draft {
  aggregation: GradeAggregation;
  categories: DraftCategory[];
  items: Record<string, { categoryId: string; weight: string }>;
}

function toDraft(setup: GradebookSetup): Draft {
  return {
    aggregation: setup.aggregation,
    categories: setup.categories.map((c) => ({
      id: c.id,
      name: c.name,
      weight: String(c.weight),
      dropLowest: String(c.dropLowest),
      isDefault: c.isDefault,
    })),
    items: Object.fromEntries(
      setup.items.map((i) => [i.activityId, { categoryId: i.categoryId, weight: i.weight == null ? '' : String(i.weight) }]),
    ),
  };
}

const blank = (v: string) => v.trim() === '';
const toNumber = (v: string) => (blank(v) ? 0 : Number(v));

function inRange(v: string, min: number, max: number, integer = false) {
  if (blank(v)) return true;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
}

function toInput(draft: Draft): GradebookSetupInput {
  return {
    aggregation: draft.aggregation,
    categories: draft.categories.map((c) => ({
      id: c.id,
      name: c.name.trim(),
      weight: toNumber(c.weight),
      dropLowest: toNumber(c.dropLowest),
    })),
    items: Object.entries(draft.items).map(([activityId, item]) => ({
      activityId,
      categoryId: item.categoryId,
      weight: blank(item.weight) ? null : Number(item.weight),
    })),
  };
}

type CategoryErrors = Partial<Record<'name' | 'weight' | 'dropLowest', string>>;

function findProblems(draft: Draft) {
  const categories: Record<string, CategoryErrors> = {};
  const names = new Set<string>();
  for (const c of draft.categories) {
    const errors: CategoryErrors = {};
    const key = c.name.trim().toLocaleLowerCase();
    if (!key) errors.name = 'Add a name';
    else if (names.has(key)) errors.name = 'Another category has this name';
    names.add(key);
    if (draft.aggregation === 'weighted' && !inRange(c.weight, 0, 100)) errors.weight = 'Use 0 to 100';
    if (!inRange(c.dropLowest, 0, 50, true)) errors.dropLowest = 'Use a whole number, 0 to 50';
    if (Object.keys(errors).length) categories[c.id] = errors;
  }
  const items: Record<string, string> = {};
  if (draft.aggregation === 'weighted') {
    for (const [id, item] of Object.entries(draft.items)) if (!inRange(item.weight, 0, 10_000)) items[id] = 'Use 0 to 10,000';
  }
  const noWeight = draft.aggregation === 'weighted' && !draft.categories.some((c) => toNumber(c.weight) > 0);
  const first = Object.entries(categories)[0];
  const firstField = first
    ? `category-${first[0]}-${Object.keys(first[1])[0]}`
    : Object.keys(items)[0]
      ? `item-${Object.keys(items)[0]}-weight`
      : noWeight
        ? `category-${draft.categories[0]?.id}-weight`
        : null;
  return { categories, items, noWeight, firstField };
}

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-6 border-b py-8 first:pt-0 last:border-0 last:pb-0 md:grid-cols-[240px_minmax(0,1fr)]">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <div className="mt-1 text-sm text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1 text-xs text-destructive">
      {children}
    </p>
  );
}

function HowItWorks({ weighted }: { weighted: boolean }) {
  const points = weighted
    ? [
        "Each category's subtotal counts by its weight. Categories with no grades yet are left out and the others are scaled up to fill 100%, so weights that don't add up to 100% still work.",
        'A category with a weight of 0% never counts.',
        'Within a category, activities count by their points unless you give them a weight.',
      ]
    : [
        'The course total is the points earned out of the points possible on everything graded so far.',
        "Work that hasn't been graded yet counts neither for nor against anyone.",
        'Drop-lowest rules apply. Category and activity weights are kept but only used with weighted categories.',
      ];
  return (
    <ul className="list-disc space-y-1 rounded-lg bg-muted/50 py-3 pr-4 pl-8 text-sm text-muted-foreground">
      {points.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

function SetupForm({ setup, courseId, editable }: { setup: GradebookSetup; courseId: string; editable: boolean }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => toDraft(setup));
  const [showErrors, setShowErrors] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const nextId = useRef(1);
  const baseline = useMemo(() => JSON.stringify(toInput(toDraft(setup))), [setup]);
  const dirty = JSON.stringify(toInput(draft)) !== baseline;
  useUnsavedChanges(dirty);
  const problems = findProblems(draft);

  // Reordering moves DOM nodes, which drops focus: put it back on the control the user was using.
  // Scrolling honours the controls' scroll margins, so nothing ends up under the sticky bars.
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(focusId);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
    setFocusId(null);
  }, [focusId]);

  const save = useMutation({
    mutationFn: () => api.put<GradebookSetup>(`/courses/${courseId}/grades/setup`, toInput(draft)),
    onSuccess: async (saved) => {
      qc.setQueryData(['grade-setup', courseId], saved);
      setDraft(toDraft(saved));
      setShowErrors(false);
      toast.success('Gradebook setup saved');
      await qc.invalidateQueries({ queryKey: ['grades', courseId] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const weighted = draft.aggregation === 'weighted';
  const defaultId = draft.categories.find((c) => c.isDefault)?.id ?? courseId;
  const totalWeight = draft.categories.reduce((sum, c) => sum + (inRange(c.weight, 0, 100) ? toNumber(c.weight) : 0), 0);
  const balanced = Math.abs(totalWeight - 100) < 0.005;
  const counts = new Map<string, number>();
  for (const item of Object.values(draft.items)) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);

  const setCategory = (id: string, patch: Partial<DraftCategory>) =>
    setDraft((d) => ({ ...d, categories: d.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const setItem = (id: string, patch: Partial<Draft['items'][string]>) =>
    setDraft((d) => ({ ...d, items: { ...d.items, [id]: { ...d.items[id]!, ...patch } } }));

  const setAggregation = (aggregation: GradeAggregation) =>
    setDraft((d) => {
      if (aggregation === 'weighted') return { ...d, aggregation };
      // Weights are hidden in natural mode, so don't keep half-typed ones that would block saving.
      const saved = toDraft(setup);
      const savedWeights = new Map(saved.categories.map((c) => [c.id, c.weight]));
      return {
        ...d,
        aggregation,
        categories: d.categories.map((c) => (inRange(c.weight, 0, 100) ? c : { ...c, weight: savedWeights.get(c.id) ?? '0' })),
        items: Object.fromEntries(
          Object.entries(d.items).map(([id, item]) => [
            id,
            inRange(item.weight, 0, 10_000) ? item : { ...item, weight: saved.items[id]?.weight ?? '' },
          ]),
        ),
      };
    });

  const addCategory = () => {
    const id = `new-${nextId.current++}`;
    setDraft((d) => {
      const categories = [...d.categories];
      const at = categories[categories.length - 1]?.isDefault ? categories.length - 1 : categories.length;
      categories.splice(at, 0, { id, name: '', weight: '0', dropLowest: '0', isDefault: false });
      return { ...d, categories };
    });
    setFocusId(`category-${id}-name`);
  };

  const removeCategory = (id: string) => {
    setDraft((d) => ({
      ...d,
      categories: d.categories.filter((c) => c.id !== id),
      items: Object.fromEntries(
        Object.entries(d.items).map(([activityId, item]) => [
          activityId,
          item.categoryId === id ? { ...item, categoryId: defaultId } : item,
        ]),
      ),
    }));
    setFocusId('add-category');
  };

  const move = (id: string, delta: -1 | 1) => {
    const from = draft.categories.findIndex((c) => c.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= draft.categories.length) return;
    setDraft((d) => {
      const categories = [...d.categories];
      [categories[from], categories[to]] = [categories[to]!, categories[from]!];
      return { ...d, categories };
    });
    const atEdge = to === 0 || to === draft.categories.length - 1;
    setFocusId(`category-${id}-${atEdge ? (delta < 0 ? 'down' : 'up') : delta < 0 ? 'up' : 'down'}`);
  };

  // Each activity's share of its category, assuming everything is graded (the same rules as the server).
  const shares = useMemo(() => {
    const effective = (item: GradeItemSetting) => {
      const w = draft.items[item.activityId]?.weight ?? '';
      if (!weighted || blank(w)) return item.maxGrade;
      return inRange(w, 0, 10_000) && item.maxGrade > 0 ? Number(w) : 0;
    };
    const sums = new Map<string, number>();
    for (const item of setup.items) {
      const category = draft.items[item.activityId]?.categoryId ?? defaultId;
      sums.set(category, (sums.get(category) ?? 0) + effective(item));
    }
    return new Map(
      setup.items.map((item) => {
        const sum = sums.get(draft.items[item.activityId]?.categoryId ?? defaultId) ?? 0;
        const e = effective(item);
        return [item.activityId, sum > 0 && e > 0 ? (e / sum) * 100 : null];
      }),
    );
  }, [draft.items, setup.items, defaultId, weighted]);

  const itemCols = weighted ? 'sm:grid-cols-[minmax(0,1fr)_12rem_7rem]' : 'sm:grid-cols-[minmax(0,1fr)_12rem]';
  const gridCols = weighted
    ? 'grid-cols-[2rem_minmax(0,1fr)_2.25rem] sm:grid-cols-[2rem_minmax(0,1fr)_6.5rem_6.5rem_5.5rem_2.25rem]'
    : 'grid-cols-[2rem_minmax(0,1fr)_2.25rem] sm:grid-cols-[2rem_minmax(0,1fr)_6.5rem_5.5rem_2.25rem]';

  return (
    <form
      noValidate
      className="[&_button]:scroll-mt-32 [&_button]:scroll-mb-28 [&_input]:scroll-mt-32 [&_input]:scroll-mb-28 [&_select]:scroll-mt-32 [&_select]:scroll-mb-28"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.firstField) {
          setShowErrors(true);
          setFocusId(problems.firstField);
          toast.error('Some fields need fixing before you can save.');
          return;
        }
        save.mutate();
      }}
    >
      <fieldset disabled={!editable} className="m-0 min-w-0 border-0 p-0">
        {!editable && (
          <p className="mb-4 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            You can see how grades are calculated here. Only teachers can change it.
          </p>
        )}
        <Card className="p-6 sm:p-8">
          <Section title="Course total" description="How grades add up to each student's course total.">
            <ChoiceCards<GradeAggregation>
              columns={2}
              value={draft.aggregation}
              onChange={setAggregation}
              options={[
                {
                  value: 'natural',
                  label: 'Natural (points)',
                  description: 'Points earned out of points possible. Activities worth more points count more.',
                  icon: <Sigma className="size-4" />,
                },
                {
                  value: 'weighted',
                  label: 'Weighted categories',
                  description: 'Each category is worth a set share of the total, however many points it has.',
                  icon: <Scale className="size-4" />,
                },
              ]}
            />
            <HowItWorks weighted={weighted} />
          </Section>

          <Section
            title="Categories"
            description={
              <>
                <p>The order is used in the gradebook and on students' grades pages.</p>
                <p className="mt-2">
                  <span className="font-medium text-foreground">Drop lowest</span> leaves out each student's lowest grades in the category.
                  At least one grade always counts.
                </p>
              </>
            }
          >
            <div>
              <div aria-hidden className={cn('mb-2 hidden gap-x-3 px-2.5 text-xs font-medium text-muted-foreground sm:grid', gridCols)}>
                <span />
                <span>Name</span>
                {weighted && <span>Weight</span>}
                <span>Drop lowest</span>
                <span className="text-right">Activities</span>
                <span />
              </div>
              <ol className="space-y-2">
                {draft.categories.map((c, index) => {
                  const errors = showErrors ? (problems.categories[c.id] ?? {}) : {};
                  const label = c.name.trim() || `category ${index + 1}`;
                  const count = counts.get(c.id) ?? 0;
                  const base = `category-${c.id}`;
                  return (
                    <li
                      key={c.id}
                      className={cn('grid items-start gap-x-3 gap-y-2 rounded-lg border bg-card p-2.5 sm:items-center', gridCols)}
                    >
                      <div className="row-span-2 flex flex-col items-center sm:row-span-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          id={`${base}-up`}
                          aria-label={`Move ${label} up`}
                          disabled={index === 0}
                          onClick={() => move(c.id, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          id={`${base}-down`}
                          aria-label={`Move ${label} down`}
                          disabled={index === draft.categories.length - 1}
                          onClick={() => move(c.id, 1)}
                        >
                          <ArrowDown />
                        </Button>
                      </div>
                      <div className="min-w-0">
                        <Input
                          id={`${base}-name`}
                          aria-label={`Name of category ${index + 1}`}
                          placeholder="Category name"
                          maxLength={80}
                          value={c.name}
                          onChange={(e) => setCategory(c.id, { name: e.target.value })}
                          aria-invalid={errors.name ? true : undefined}
                          aria-describedby={errors.name ? `${base}-name-error` : undefined}
                        />
                        {errors.name && <FieldError id={`${base}-name-error`}>{errors.name}</FieldError>}
                        {c.isDefault && (
                          <p className="mt-1.5 text-xs text-muted-foreground">
                            <Badge variant="neutral" className="mr-1.5">
                              Default
                            </Badge>
                            Activities without a category count here.
                          </p>
                        )}
                        {weighted && count > 0 && toNumber(c.weight) === 0 && (
                          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                            Its {plural(count, 'activity', 'activities')} won't count while its weight is 0%.
                          </p>
                        )}
                      </div>
                      <div className="col-span-2 col-start-2 row-start-2 grid grid-cols-2 items-start gap-x-3 gap-y-1.5 sm:contents">
                        {weighted && (
                          <div className="min-w-0">
                            <label htmlFor={`${base}-weight`} className="mb-1 block text-xs text-muted-foreground sm:sr-only">
                              Weight<span className="sr-only"> of {label}</span>
                            </label>
                            <div className="relative">
                              <Input
                                id={`${base}-weight`}
                                type="number"
                                inputMode="decimal"
                                min={0}
                                max={100}
                                step="any"
                                value={c.weight}
                                onChange={(e) => setCategory(c.id, { weight: e.target.value })}
                                className="[appearance:textfield] pr-7 text-right tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                aria-invalid={errors.weight ? true : undefined}
                                aria-describedby={errors.weight ? `${base}-weight-error` : undefined}
                              />
                              <span
                                aria-hidden
                                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground"
                              >
                                %
                              </span>
                            </div>
                            {errors.weight && <FieldError id={`${base}-weight-error`}>{errors.weight}</FieldError>}
                          </div>
                        )}
                        <div className="min-w-0">
                          <label htmlFor={`${base}-dropLowest`} className="mb-1 block text-xs text-muted-foreground sm:sr-only">
                            Drop lowest<span className="sr-only"> in {label}</span>
                          </label>
                          <Input
                            id={`${base}-dropLowest`}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={50}
                            step={1}
                            value={c.dropLowest}
                            onChange={(e) => setCategory(c.id, { dropLowest: e.target.value })}
                            className="text-right tabular-nums"
                            aria-invalid={errors.dropLowest ? true : undefined}
                            aria-describedby={errors.dropLowest ? `${base}-dropLowest-error` : undefined}
                          />
                          {errors.dropLowest && <FieldError id={`${base}-dropLowest-error`}>{errors.dropLowest}</FieldError>}
                        </div>
                        <p className="col-span-2 text-xs text-muted-foreground tabular-nums sm:col-span-1 sm:self-center sm:text-right">
                          {plural(count, 'activity', 'activities')}
                        </p>
                      </div>
                      <div className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto">
                        {!c.isDefault && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${label}`}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => removeCategory(c.id)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  id="add-category"
                  onClick={addCategory}
                  disabled={draft.categories.length >= 50}
                >
                  <Plus /> Add category
                </Button>
                {weighted && (
                  <p
                    role="status"
                    className={cn(
                      'inline-flex items-center gap-1.5 text-sm font-medium tabular-nums',
                      balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400',
                    )}
                  >
                    {balanced ? <CircleCheck className="size-4" /> : <CircleAlert className="size-4" />}
                    Weights add up to {formatWeight(totalWeight)}
                  </p>
                )}
              </div>
              {weighted && !balanced && (
                <p className="mt-2 text-xs text-muted-foreground">
                  That still works: totals are scaled over the categories that have grades, so weights act as proportions. Make them add up
                  to 100% so they read as shares of the course total.
                </p>
              )}
              {showErrors && problems.noWeight && (
                <p className="mt-2 text-sm text-destructive">Give at least one category a weight above 0%, or nothing would count.</p>
              )}
            </div>
          </Section>

          <Section
            title="Graded activities"
            description={
              weighted
                ? 'Choose a category for each activity. Activities count by their points; give one a weight to set its share of the category instead (weights 1 and 3 make 25% and 75%).'
                : 'Choose a category for each activity. With natural totals every activity counts by its points; activity weights come with weighted categories.'
            }
          >
            {setup.items.length === 0 ? (
              <EmptyState
                icon={Award}
                title="No graded activities yet"
                description="Assignments and quizzes show up here once you add them. You can set up the categories now."
              />
            ) : (
              <div>
                <div aria-hidden className={cn('mb-2 hidden gap-x-3 px-3 text-xs font-medium text-muted-foreground sm:grid', itemCols)}>
                  <span>Activity</span>
                  <span>Category</span>
                  {weighted && <span className="text-right">Weight</span>}
                </div>
                <ul className="divide-y rounded-lg border">
                  {setup.items.map((item) => {
                    const state = draft.items[item.activityId] ?? { categoryId: defaultId, weight: '' };
                    const error = showErrors ? problems.items[item.activityId] : undefined;
                    const share = shares.get(item.activityId) ?? null;
                    const categoryName = draft.categories.find((c) => c.id === state.categoryId)?.name.trim() || 'its category';
                    const base = `item-${item.activityId}`;
                    return (
                      <li key={item.activityId} className={cn('grid gap-x-3 gap-y-2.5 px-3 py-3 sm:items-center', itemCols)}>
                        <div className="flex min-w-0 items-center gap-3">
                          <ActivityIcon type={item.type} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium" id={`${base}-title`}>
                              {item.title}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {formatNumber(item.maxGrade)} points
                              {!item.visible && ' · hidden'}
                              {' · '}
                              {share != null ? `${formatPercent(share)} of ${categoryName}` : "doesn't count"}
                            </p>
                          </div>
                        </div>
                        <div className={cn('grid items-start gap-2 sm:contents', weighted && 'grid-cols-[minmax(0,1fr)_7rem]')}>
                          <Select
                            aria-label={`Category for ${item.title}`}
                            value={state.categoryId}
                            onChange={(e) => setItem(item.activityId, { categoryId: e.target.value })}
                          >
                            {draft.categories.map((c, index) => (
                              <option key={c.id} value={c.id}>
                                {c.name.trim() || `Category ${index + 1}`}
                              </option>
                            ))}
                          </Select>
                          {weighted && (
                            <div>
                              <Input
                                id={`${base}-weight`}
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step="any"
                                aria-label={`Weight of ${item.title} in its category`}
                                placeholder={`${formatNumber(item.maxGrade)} pts`}
                                value={state.weight}
                                onChange={(e) => setItem(item.activityId, { weight: e.target.value })}
                                className="text-right tabular-nums"
                                aria-invalid={error ? true : undefined}
                                aria-describedby={error ? `${base}-weight-error` : undefined}
                              />
                              {error && <FieldError id={`${base}-weight-error`}>{error}</FieldError>}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Section>
        </Card>

        {editable && (
          <div className="sticky bottom-4 z-10 mt-6 flex items-center justify-end gap-3 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur">
            {dirty && <span className="mr-auto pl-2 text-sm text-muted-foreground">You have unsaved changes</span>}
            <Button
              type="button"
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setDraft(toDraft(setup));
                setShowErrors(false);
              }}
            >
              Discard
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

export default function GradebookSetupPage() {
  const { course, can } = useCourseContext();
  useTitle(`Categories & weights · ${course.title}`);
  const staff = can('grades:viewAll');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['grade-setup', course.id],
    queryFn: () => api.get<GradebookSetup>(`/courses/${course.id}/grades/setup`),
    enabled: staff,
  });

  return (
    <Page>
      <div className="mb-6">
        <Link
          to={`/courses/${course.slug}/grades`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Grades
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Categories &amp; weights</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Group graded activities into categories, decide what each one is worth and choose how the course total is calculated.
        </p>
      </div>
      {!staff ? (
        <EmptyState
          icon={Lock}
          title="Only course staff can see this"
          description="Teachers set up grade categories and weights here. Your grades and how they add up are on the Grades page."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={`/courses/${course.slug}/grades`}>Go to my grades</Link>
            </Button>
          }
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <Skeleton className="h-[560px]" />
      ) : (
        <SetupForm setup={data} courseId={course.id} editable={can('grades:manage')} />
      )}
    </Page>
  );
}
