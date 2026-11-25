import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary/10 text-primary',
        neutral: 'bg-muted text-muted-foreground',
        outline: 'border text-muted-foreground',
        success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
        warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
        danger: 'bg-red-500/12 text-red-700 dark:text-red-400',
        info: 'bg-sky-500/12 text-sky-700 dark:text-sky-400',
        violet: 'bg-violet-500/12 text-violet-700 dark:text-violet-400',
        solid: 'bg-foreground text-background',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
