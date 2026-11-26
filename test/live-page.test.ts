import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LiveClassInfo } from '../src/shared/live.js';
import type { ActivityDetail } from '../src/shared/types.js';
import type { Coursekit } from '../src/server/index.js';
import { createTestLms, setupSchool } from './helpers.js';
import { createLiveClass, inMinutes, installFetch, quietWorker, schedule, uninstallFetch } from './live-helpers.js';

// The live class page, rendered to HTML (no browser) with what the API returns, through the web build's own config.

let vite: ViteDevServer;
let lms: Coursekit;
let school: Awaited<ReturnType<typeof setupSchool>>;

beforeAll(async () => {
  vite = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    logLevel: 'silent',
    // DOMPurify needs a DOM, and nothing here renders Markdown. The page's libraries come through the same resolution
    // as the page itself, so React contexts match.
    ssr: { noExternal: ['dompurify'] },
    plugins: [
      {
        name: 'live-page-test',
        enforce: 'pre',
        resolveId: (id) => (id === 'dompurify' || id === 'virtual:render' ? `\0${id}` : null),
        load(id) {
          if (id === '\0dompurify') return 'export default { addHook() {}, sanitize: (html) => html };';
          if (id === '\0virtual:render') {
            return [
              "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
              "import { createElement as h } from 'react';",
              "import { renderToStaticMarkup } from 'react-dom/server';",
              "import { MemoryRouter } from 'react-router';",
              "import { LiveClassView } from '/pages/activities/LiveClassView.tsx';",
              'export function render(activity, info) {',
              '  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });',
              "  qc.setQueryData(['live', activity.id], info);",
              '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(LiveClassView, { activity }))));',
              '}',
            ].join('\n');
          }
          return null;
        },
      },
    ],
  });
});

afterAll(() => vite.close());

beforeEach(async () => {
  installFetch();
  lms = await createTestLms();
  await quietWorker(lms);
  school = await setupSchool(lms);
  await school.teacher.post(`/api/courses/${school.course.id}/participants`, { emails: ['sam@test.dev'] });
});

afterEach(async () => {
  await lms.close();
  uninstallFetch();
});

/** The class page as a student sees it, and what it was rendered from. */
async function render(activityId: string) {
  const { render } = await vite.ssrLoadModule('virtual:render');
  const activity = (await school.sam.get<ActivityDetail<'live'>>(`/api/activities/${activityId}`)).body;
  const info = (await school.sam.get<LiveClassInfo>(`/api/live/activities/${activityId}`)).body;
  return { html: render(activity, info) as string, info };
}

/** A link's accessible name below Tailwind's sm breakpoint, where `hidden` leaves out text and `sr-only` doesn't. */
function phoneName(html: string, href: string): string {
  const link = html.match(new RegExp(`<a href="${href}"([^>]*)>([\\s\\S]*?)</a>`));
  if (!link) throw new Error(`No link to ${href}`);
  const label = link[1]!.match(/aria-label="([^"]*)"/);
  if (label) return label[1]!;
  return link[2]!
    .replace(/<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>/g, '')
    .replace(/<(\w+) class="(?:[^"]* )?hidden(?: [^"]*)?"[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

describe('the live class page', () => {
  it('wraps a long link in a session agenda instead of making phones scroll sideways', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    const agenda = `Slides: https://docs.google.com/presentation/d/${'x'.repeat(48)}/edit\nBring questions`;
    await schedule(school.teacher, activity, { startsAt: inMinutes(120), agenda });
    const { html } = await render(activity);
    const shown = html.match(/<p class="([^"]*)">Slides: https:\/\/docs\.google\.com[^<]*<\/p>/);
    expect(shown?.[1]!.split(' ')).toEqual(expect.arrayContaining(['break-words', 'whitespace-pre-line']));
  });

  it('names the calendar links on phones too, where “Add all to calendar” shows only its icon', async () => {
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId);
    await schedule(school.teacher, activity, { startsAt: inMinutes(120) });
    const { html, info } = await render(activity);
    expect(phoneName(html, info.icsUrl)).toBe('Add all to calendar');
    expect(phoneName(html, info.sessions[0]!.icsUrl)).toBe('Add to calendar');
  });

  it('refreshes its sessions once the class is edited, though saving the editor refetches only the activity', async () => {
    const { refreshOnSetupChange } = await vite.ssrLoadModule('/components/live/setup.ts');
    const activity = await createLiveClass(school.teacher, school.course.id, school.sectionId, {
      settings: { provider: null, meetingUrl: null },
    });
    const detail = async () => (await school.teacher.get<ActivityDetail<'live'>>(`/api/activities/${activity}`)).body;
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const before = await detail();
    qc.setQueryData(['activity', activity], before);
    qc.setQueryData(['live', activity], (await school.teacher.get<LiveClassInfo>(`/api/live/activities/${activity}`)).body);
    const stop = refreshOnSetupChange(qc, activity);
    const stale = () => qc.getQueryState(['live', activity])!.isInvalidated;

    // A refetch that changes nothing the editor sets (the viewer's progress), or another activity: nothing to refresh.
    qc.setQueryData(['activity', activity], { ...before, completed: !before.completed });
    qc.setQueryData(['activity', 'another'], { ...before, id: 'another', settings: { ...before.settings, provider: 'link' } });
    expect(stale()).toBe(false);
    // "Choose how this class meets": the teacher picks a meeting link in the editor and saves.
    const settings = { ...before.settings, provider: 'link', meetingUrl: 'https://meet.example.com/abc-defg-hij' };
    expect((await school.teacher.patch(`/api/activities/${activity}`, { settings })).status).toBe(200);
    qc.setQueryData(['activity', activity], await detail());
    expect(stale()).toBe(true);
    stop();
  });
});
