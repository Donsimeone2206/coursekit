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

/** Gradient (light → deep) and the darker tone used for the rosette edge and ribbons. */
export const BADGE_COLOR_META: Record<BadgeColor, { from: string; to: string; edge: string; label: string }> = {
  gold: { from: '#fcd34d', to: '#d97706', edge: '#b45309', label: 'Gold' },
  silver: { from: '#e2e8f0', to: '#64748b', edge: '#475569', label: 'Silver' },
  bronze: { from: '#f0a868', to: '#9a4a1c', edge: '#7a3a16', label: 'Bronze' },
  indigo: { from: '#a5b4fc', to: '#4f46e5', edge: '#3730a3', label: 'Indigo' },
  violet: { from: '#c4b5fd', to: '#7c3aed', edge: '#5b21b6', label: 'Violet' },
  sky: { from: '#7dd3fc', to: '#0284c7', edge: '#075985', label: 'Sky' },
  teal: { from: '#5eead4', to: '#0d9488', edge: '#115e59', label: 'Teal' },
  emerald: { from: '#6ee7b7', to: '#059669', edge: '#065f46', label: 'Emerald' },
  rose: { from: '#fda4af', to: '#e11d48', edge: '#9f1239', label: 'Rose' },
  fuchsia: { from: '#f0abfc', to: '#c026d3', edge: '#86198f', label: 'Fuchsia' },
};

/** Points of the rosette's serrated edge: a 24-point star around the medal. */
const ROSETTE = Array.from({ length: 48 }, (_, i) => {
  const angle = (Math.PI * i) / 24 - Math.PI / 2;
  const r = i % 2 === 0 ? 45 : 40.5;
  return `${(50 + r * Math.cos(angle)).toFixed(2)},${(48 + r * Math.sin(angle)).toFixed(2)}`;
}).join(' ');

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
      <path d="M31 78 L22 108 L34 102 L40 111 L47 84 Z" fill={`url(#${id}-ribbon)`} />
      <path d="M69 78 L78 108 L66 102 L60 111 L53 84 Z" fill={`url(#${id}-ribbon)`} />
      <polygon points={ROSETTE} fill={tone.edge} strokeLinejoin="round" stroke={tone.edge} strokeWidth="1.5" />
      <circle cx="50" cy="48" r="37" fill={`url(#${id}-fill)`} />
      <circle cx="50" cy="48" r="31" fill="none" stroke="white" strokeOpacity="0.45" strokeWidth="1.5" />
      <ellipse cx="40" cy="30" rx="18" ry="9" fill="white" opacity="0.18" transform="rotate(-24 40 30)" />
      <Icon x={32} y={30} width={36} height={36} color="#ffffff" strokeWidth={2.1} />
    </svg>
  );
}
