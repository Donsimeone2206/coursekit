import { Hono } from 'hono';
import { z } from 'zod';
import type { Category } from '../../shared/types.js';
import { requireAdmin, requireUser, type AppDeps, type AppEnv } from '../context.js';
import { conflict, notFound, readBody } from '../lib/http.js';
import { newId, now, num, slugify } from '../lib/util.js';

export function categoryRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const { db } = deps;

  const input = z.object({
    name: z.string().trim().min(1, 'Enter a name').max(80),
    description: z.string().trim().max(500).default(''),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  });

  r.get('/', async (c) => {
    requireUser(c);
    const rows = await db.selectFrom('categories').selectAll().orderBy('sortOrder', 'asc').orderBy('name', 'asc').execute();
    const counts = await db
      .selectFrom('courses')
      .select(['categoryId', (eb) => eb.fn.countAll().as('n')])
      .where('visibility', '=', 'published')
      .groupBy('categoryId')
      .execute();
    const countMap = new Map(counts.map((r) => [r.categoryId, num(r.n)]));
    const categories: Category[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      sortOrder: row.sortOrder,
      courseCount: countMap.get(row.id) ?? 0,
    }));
    return c.json(categories);
  });

  r.post('/', async (c) => {
    requireAdmin(c);
    const data = await readBody(c, input);
    const slug = slugify(data.name, 'category');
    if (await db.selectFrom('categories').select('id').where('slug', '=', slug).executeTakeFirst()) {
      throw conflict('A category with this name already exists.');
    }
    const max = await db
      .selectFrom('categories')
      .select((eb) => eb.fn.max('sortOrder').as('m'))
      .executeTakeFirst();
    const row = {
      id: newId(),
      name: data.name,
      slug,
      description: data.description,
      sortOrder: data.sortOrder ?? num(max?.m) + 1,
      createdAt: now(),
    };
    await db.insertInto('categories').values(row).execute();
    return c.json({ ...row, courseCount: 0 } satisfies Category, 201);
  });

  r.patch('/:id', async (c) => {
    requireAdmin(c);
    const id = c.req.param('id');
    const data = await readBody(c, input.partial().extend({ description: z.string().trim().max(500).optional() }));
    const existing = await db.selectFrom('categories').selectAll().where('id', '=', id).executeTakeFirst();
    if (!existing) throw notFound('Category');
    const slug = data.name ? slugify(data.name, 'category') : existing.slug;
    if (slug !== existing.slug && (await db.selectFrom('categories').select('id').where('slug', '=', slug).executeTakeFirst())) {
      throw conflict('A category with this name already exists.');
    }
    await db
      .updateTable('categories')
      .set({ ...data, slug })
      .where('id', '=', id)
      .execute();
    return c.json({ ok: true });
  });

  r.delete('/:id', async (c) => {
    requireAdmin(c);
    const result = await db.deleteFrom('categories').where('id', '=', c.req.param('id')).executeTakeFirst();
    if (num(result.numDeletedRows) === 0) throw notFound('Category');
    return c.json({ ok: true });
  });

  return r;
}
