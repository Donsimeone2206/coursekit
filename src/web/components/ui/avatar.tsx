import type { PublicUser } from '@shared/types';
import { cn, colorFor, initials } from '@/lib/utils';

const SIZES = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-9 text-[13px]',
  lg: 'size-12 text-base',
  xl: 'size-20 text-2xl',
} as const;

export function Avatar({
  user,
  size = 'md',
  className,
}: {
  user: Pick<PublicUser, 'id' | 'name' | 'avatarUrl'>;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'relative inline-grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-semibold text-white ring-2 ring-card',
        SIZES[size],
        !user.avatarUrl && colorFor(user.id),
        className,
      )}
      title={user.name}
    >
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="size-full object-cover" /> : initials(user.name)}
    </span>
  );
}

export function AvatarStack({ users, max = 3, size = 'xs' }: { users: PublicUser[]; max?: number; size?: keyof typeof SIZES }) {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((u) => (
        <Avatar key={u.id} user={u} size={size} />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            'inline-grid place-items-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-card',
            SIZES[size],
          )}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
