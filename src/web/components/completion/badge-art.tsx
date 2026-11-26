import {
  Award,
  BookOpen,
  Brain,
  CodeXml,
  Crown,
  Flame,
  Gem,
  Globe,
  GraduationCap,
  Heart,
  Lightbulb,
  Medal,
  MessageCircle,
  Puzzle,
  Rocket,
  Sparkles,
  Star,
  Target,
  Trophy,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useId } from 'react';
import { BADGE_COLOR_META, BADGE_RIBBON_PATHS, BADGE_ROSETTE_POINTS } from '@shared/badge-art';
import type { BadgeColor, BadgeIcon } from '@shared/completion';
import { cn } from '@/lib/utils';

export const BADGE_ICON_META: Record<BadgeIcon, { icon: LucideIcon; label: string }> = {
  award: { icon: Award, label: 'Rosette' },
  medal: { icon: Medal, label: 'Medal' },
  trophy: { icon: Trophy, label: 'Trophy' },
  star: { icon: Star, label: 'Star' },
  rocket: { icon: Rocket, label: 'Rocket' },
  flame: { icon: Flame, label: 'Flame' },
  zap: { icon: Zap, label: 'Lightning' },
  crown: { icon: Crown, label: 'Crown' },
  gem: { icon: Gem, label: 'Gem' },
  heart: { icon: Heart, label: 'Heart' },
  lightbulb: { icon: Lightbulb, label: 'Light bulb' },
  target: { icon: Target, label: 'Target' },
  'graduation-cap': { icon: GraduationCap, label: 'Graduation cap' },
  'book-open': { icon: BookOpen, label: 'Book' },
  code: { icon: CodeXml, label: 'Code' },
  puzzle: { icon: Puzzle, label: 'Puzzle' },
  brain: { icon: Brain, label: 'Brain' },
  sparkles: { icon: Sparkles, label: 'Sparkles' },
  'message-circle': { icon: MessageCircle, label: 'Speech bubble' },
  globe: { icon: Globe, label: 'Globe' },
};

export { BADGE_COLOR_META };

/**
 * Badge artwork: a rosette medal with ribbons in one of the preset colours, and a white icon.
 * `locked` shows a badge the viewer hasn't earned (greyed out).
 */
export function BadgeArt({
  icon,
  color,
  size = 64,
  locked,
  label,
  className,
}: {
  icon: BadgeIcon;
  color: BadgeColor;
  size?: number;
  locked?: boolean;
  /** Accessible name; leave out when the badge name is shown next to it. */
  label?: string;
  className?: string;
}) {
  const id = `ck-badge-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const tone = BADGE_COLOR_META[color] ?? BADGE_COLOR_META.gold;
  const Icon = (BADGE_ICON_META[icon] ?? BADGE_ICON_META.award).icon;
  return (
    <svg
      viewBox="0 0 100 112"
      width={size}
      height={(size * 112) / 100}
      className={cn('shrink-0 drop-shadow-sm', locked && 'opacity-45 grayscale', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor={tone.from} />
          <stop offset="1" stopColor={tone.to} />
        </linearGradient>
        <linearGradient id={`${id}-ribbon`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone.to} />
          <stop offset="1" stopColor={tone.edge} />
        </linearGradient>
      </defs>
      {BADGE_RIBBON_PATHS.map((d) => (
        <path key={d} d={d} fill={`url(#${id}-ribbon)`} />
      ))}
      <polygon points={BADGE_ROSETTE_POINTS} fill={tone.edge} strokeLinejoin="round" stroke={tone.edge} strokeWidth="1.5" />
      <circle cx="50" cy="48" r="37" fill={`url(#${id}-fill)`} />
      <circle cx="50" cy="48" r="31" fill="none" stroke="white" strokeOpacity="0.45" strokeWidth="1.5" />
      <ellipse cx="40" cy="30" rx="18" ry="9" fill="white" opacity="0.18" transform="rotate(-24 40 30)" />
      <Icon x={32} y={30} width={36} height={36} color="#ffffff" strokeWidth={2.1} />
    </svg>
  );
}
