import type { CourseRef, FileInfo, PublicUser, User } from '../../shared/types.js';
import type { CourseRow, FileRow, UserRow } from '../db/schema.js';

export function toPublicUser(u: Pick<UserRow, 'id' | 'name' | 'avatarUrl'>): PublicUser {
  return { id: u.id, name: u.name, avatarUrl: u.avatarUrl };
}

export function toUser(u: UserRow): User {
  return {
    id: u.id,
    name: u.name,
    avatarUrl: u.avatarUrl,
    email: u.email,
    role: u.role,
    bio: u.bio,
    status: u.status,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function toCourseRef(c: Pick<CourseRow, 'id' | 'slug' | 'title' | 'coverColor'>): CourseRef {
  return { id: c.id, slug: c.slug, title: c.title, coverColor: c.coverColor };
}

export function fileUrl(id: string): string {
  return `/api/files/${id}`;
}

export function toFileInfo(f: FileRow): FileInfo {
  return { id: f.id, name: f.name, size: f.size, mime: f.mime, url: fileUrl(f.id), createdAt: f.createdAt };
}

/** Shorthand used by routes that select user columns under aliased names. */
export function userFrom(row: { userId: string; userName: string; userAvatarUrl: string | null }): PublicUser {
  return { id: row.userId, name: row.userName, avatarUrl: row.userAvatarUrl };
}
