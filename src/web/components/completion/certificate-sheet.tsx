import { Award, GraduationCap } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { CertificateValues } from '@shared/completion';
import { cn } from '@/lib/utils';

export interface CertificateContent {
  title: string;
  body: string;
  signatureName: string;
  signatureTitle: string;
  siteName: string;
  recipientName: string;
  courseTitle: string;
  completedAt: string;
  /** Formatted verification code (XXXX-XXXX-XXXX). */
  code: string;
}

export function certificateDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
}

export function verifyUrl(code: string): string {
  return `${window.location.origin}/verify/${code}`;
}

const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, 'Times New Roman', serif";
const BRAND = 'var(--brand-light)';
const PLACEHOLDER = /(\{(?:name|course|date|code|site)\})/g;

/** Sizes are in container units (cqw: 1% of the sheet's width), so the sheet scales on screen and fills A4 when printed. */
const styles = {
  sheet: {
    aspectRatio: '297 / 210',
    containerType: 'inline-size',
    WebkitPrintColorAdjust: 'exact',
    printColorAdjust: 'exact',
    backgroundImage: `radial-gradient(circle at 0% 0%, color-mix(in oklab, ${BRAND} 9%, transparent) 0, transparent 32%), radial-gradient(circle at 100% 100%, color-mix(in oklab, ${BRAND} 9%, transparent) 0, transparent 32%)`,
  },
  outerFrame: { inset: '1.7cqw', border: `0.28cqw solid ${BRAND}` },
  innerFrame: { inset: '2.5cqw', border: `0.09cqw solid color-mix(in oklab, ${BRAND} 40%, transparent)` },
  content: { padding: '5.2cqw 7.5cqw 4.6cqw' },
  site: { fontSize: '1.2cqw', letterSpacing: '0.28em', gap: '1cqw' },
  logo: { width: '2.6cqw', height: '2.6cqw', borderRadius: '0.7cqw', background: BRAND },
  title: { fontFamily: SERIF, fontSize: '4.5cqw', marginTop: '2.3cqw', lineHeight: 1.1 },
  ornament: { marginTop: '1.4cqw', gap: '1cqw' },
  rule: { width: '7cqw', height: '0.12cqw', background: `color-mix(in oklab, ${BRAND} 55%, transparent)` },
  diamond: { width: '0.9cqw', height: '0.9cqw', background: BRAND, transform: 'rotate(45deg)' },
  text: { fontSize: '1.65cqw', lineHeight: 1.55, marginTop: '0.5cqw' },
  name: {
    fontFamily: SERIF,
    fontStyle: 'italic',
    fontSize: '5cqw',
    lineHeight: 1.15,
    margin: '0.9cqw 0 0.7cqw',
    padding: '0 3cqw 0.5cqw',
    borderBottom: '0.1cqw solid #cbd5e1',
  },
  course: { fontSize: '2.5cqw', lineHeight: 1.25, color: BRAND, margin: '0.6cqw 0' },
  footer: { gap: '3cqw' },
  signatureLine: { borderTop: '0.1cqw solid #94a3b8', paddingTop: '0.8cqw', width: '22cqw' },
  small: { fontSize: '1.05cqw' },
  medium: { fontSize: '1.35cqw' },
  code: { fontSize: '1.45cqw', letterSpacing: '0.08em' },
  seal: { width: '8.5cqw', height: '8.5cqw' },
  watermark: { fontSize: '13cqw', letterSpacing: '0.1em' },
} satisfies Record<string, CSSProperties>;

function BodyLine({ text, values }: { text: string; values: CertificateValues }) {
  const line = text.trim();
  // A line that is only {name} or {course} is set large, like the name on a diploma.
  if (line === '{name}') {
    return (
      <p className="text-slate-900" style={styles.name}>
        {values.name}
      </p>
    );
  }
  if (line === '{course}') return <p style={{ ...styles.course, fontWeight: 600 }}>{values.course}</p>;
  const parts: ReactNode[] = line.split(PLACEHOLDER).map((part, i) => {
    const key = /^\{(name|course|date|code|site)\}$/.exec(part)?.[1] as keyof CertificateValues | undefined;
    return key ? (
      <strong key={i} className="font-semibold text-slate-800">
        {values[key]}
      </strong>
    ) : (
      part
    );
  });
  return <p style={styles.text}>{parts}</p>;
}

function Seal() {
  return (
    <svg viewBox="0 0 100 100" style={styles.seal} aria-hidden>
      <circle cx="50" cy="50" r="48" fill={BRAND} />
      <circle cx="50" cy="50" r="41" fill="none" stroke="white" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx="50" cy="50" r="34" fill="white" fillOpacity="0.14" />
      <Award x={28} y={26} width={44} height={44} color="#ffffff" strokeWidth={1.8} />
    </svg>
  );
}

/** A printable A4 landscape certificate. It stays white "paper" in dark mode, like a PDF. */
export function CertificateSheet({ content, revoked, className }: { content: CertificateContent; revoked?: boolean; className?: string }) {
  const values: CertificateValues = {
    name: content.recipientName,
    course: content.courseTitle,
    date: certificateDate(content.completedAt),
    code: content.code,
    site: content.siteName,
  };
  const lines = content.body.split('\n').filter((l) => l.trim());
  return (
    <div
      className={cn(
        'ck-certificate relative w-full overflow-hidden rounded-sm bg-white text-slate-600 shadow-xl ring-1 ring-black/5',
        className,
      )}
      style={styles.sheet}
    >
      <div className="pointer-events-none absolute" style={styles.outerFrame} />
      <div className="pointer-events-none absolute" style={styles.innerFrame} />
      <div className="absolute inset-0 flex flex-col items-center text-center" style={styles.content}>
        <div className="flex items-center font-semibold text-slate-500 uppercase" style={styles.site}>
          <span className="grid place-items-center text-white" style={styles.logo}>
            <GraduationCap style={{ width: '60%', height: '60%' }} />
          </span>
          {content.siteName}
        </div>
        <h2 className="font-medium text-slate-900" style={styles.title}>
          {content.title}
        </h2>
        <div className="flex items-center" style={styles.ornament} aria-hidden>
          <span style={styles.rule} />
          <span style={styles.diamond} />
          <span style={styles.rule} />
        </div>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center overflow-hidden">
          {lines.map((line, i) => (
            <BodyLine key={i} text={line} values={values} />
          ))}
        </div>
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-end" style={styles.footer}>
          <div className="justify-self-start text-left">
            {(content.signatureName || content.signatureTitle) && (
              <div style={styles.signatureLine}>
                <p className="font-semibold text-slate-800" style={styles.medium}>
                  {content.signatureName}
                </p>
                <p className="text-slate-500" style={styles.small}>
                  {content.signatureTitle}
                </p>
              </div>
            )}
          </div>
          <Seal />
          <div className="justify-self-end text-right">
            <p className="font-semibold tracking-widest text-slate-400 uppercase" style={styles.small}>
              Certificate code
            </p>
            <p className="font-mono font-semibold text-slate-800" style={styles.code}>
              {content.code}
            </p>
            <p className="text-slate-500" style={styles.small}>
              Verify at {window.location.host}/verify
            </p>
          </div>
        </div>
      </div>
      {revoked && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
          <span className="-rotate-12 font-black text-red-600/15 uppercase" style={styles.watermark}>
            Revoked
          </span>
        </div>
      )}
    </div>
  );
}
