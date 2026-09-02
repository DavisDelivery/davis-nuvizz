// lib/auth-store.mts — the `app_users` collection.
//
// One document per user, keyed by the normalised username. Only ever reached through
// the service account: `app_users` is in firestore.rules' server-only list, so the
// browser bundle can neither read a hash nor write itself an admin (the hole the
// audit found in load-scan's driver_auth).
//
// Every write here is a FIELD-MASKED update (updateDocFields) or an atomic create
// (createDocIfAbsent). Never setDoc: a full replace would take the password hash down
// with a display-name edit.

import { getDoc, listDocs, createDocIfAbsent, updateDocFields, isFirestoreEnabled } from './firestore.mts';
import * as fs from './firestore.mts';
import {
  type Role, normalizeRole, normalizeUsername, nextFailureState, lockFromCount,
} from './auth-core.mts';

export const USERS = 'app_users';

export interface UserDoc {
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  active: boolean;
  passwordHash: string;
  tokenVersion: number;
  failedAttempts: number;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  resetTokenHash: string | null;
  resetExpiresAt: string | null;
  resetRequestedAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string | null;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
}

/** What a client may see. Never the hash, never the reset token. */
export interface PublicUser {
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lockedUntil: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
}

export function publicUser(d: any, nowMs = Date.now()): PublicUser {
  const until = d?.lockedUntil ? Date.parse(String(d.lockedUntil)) : NaN;
  return {
    username: String(d?.username || ''),
    displayName: String(d?.displayName || d?.username || ''),
    email: d?.email ? String(d.email) : null,
    role: normalizeRole(d?.role),
    active: d?.active !== false,
    mustChangePassword: d?.mustChangePassword === true,
    locked: Number.isFinite(until) && until > nowMs,
    lockedUntil: Number.isFinite(until) && until > nowMs ? new Date(until).toISOString() : null,
    createdAt: d?.createdAt || null,
    lastLoginAt: d?.lastLoginAt || null,
  };
}

export function storeReady(): boolean {
  return isFirestoreEnabled();
}

export async function getUser(username: any): Promise<UserDoc | null> {
  const u = normalizeUsername(username);
  if (!u) return null;
  const d = await getDoc(`${USERS}/${u}`);
  if (!d || !d.username) return null;
  return d as UserDoc;
}

export async function listUsers(): Promise<UserDoc[]> {
  const rows = await listDocs(USERS);
  return rows.filter((r: any) => r && r.username).sort((a: any, b: any) => String(a.username).localeCompare(String(b.username)));
}

/** Small collection, no index needed: a linear scan is fine for a dispatch office. */
export async function findUserByEmail(email: string | null): Promise<UserDoc | null> {
  if (!email) return null;
  const rows = await listUsers();
  const hit = rows.find((r) => String(r.email || '').toLowerCase() === email.toLowerCase());
  return hit || null;
}

export async function countActiveAdmins(): Promise<number> {
  const rows = await listUsers();
  return rows.filter((r) => normalizeRole(r.role) === 'admin' && r.active !== false).length;
}

/** Atomic: false when the username is already taken. */
export async function createUser(doc: UserDoc): Promise<boolean> {
  return createDocIfAbsent(`${USERS}/${doc.username}`, doc);
}

export async function patchUser(username: string, fields: Partial<UserDoc> & Record<string, any>): Promise<void> {
  const u = normalizeUsername(username);
  if (!u) throw new Error('bad username');
  await updateDocFields(`${USERS}/${u}`, { ...fields, updatedAt: new Date().toISOString() });
}

// The shared client gained an atomic increment during the same change set; use it when
// it is there and fall back to the masked read-modify-write otherwise, so this module
// never depends on load order to be correct — only to be race-free.
function atomicIncrement(): ((path: string, inc: Record<string, number>, alsoSet?: Record<string, any>) => Promise<void>) | null {
  const f = (fs as any).incrementDocFields;
  return typeof f === 'function' ? f : null;
}

/** Bump tokenVersion: every session this user holds is invalid on the next store read. */
export async function bumpTokenVersion(doc: UserDoc, extra: Record<string, any> = {}): Promise<number> {
  const inc = atomicIncrement();
  const stamp = { ...extra, updatedAt: new Date().toISOString() };
  if (inc) {
    await inc(`${USERS}/${doc.username}`, { tokenVersion: 1 }, stamp);
    return (Number(doc.tokenVersion) || 0) + 1;
  }
  const next = (Number(doc.tokenVersion) || 0) + 1;
  await updateDocFields(`${USERS}/${doc.username}`, { tokenVersion: next, ...stamp });
  return next;
}

/**
 * One more wrong password. With the atomic helper the counter cannot lose a race
 * (audit finding 17: parallel guesses each cost one increment in load-scan); the
 * lock decision is made on the value read back AFTER the increment.
 */
export async function recordLoginFailure(doc: UserDoc, nowMs = Date.now()): Promise<{ failedAttempts: number; lockedUntil: string | null }> {
  const path = `${USERS}/${doc.username}`;
  const inc = atomicIncrement();
  if (inc) {
    const expired = doc.lockedUntil && Date.parse(String(doc.lockedUntil)) <= nowMs;
    if (expired) {
      // A lockout that has run out starts the count again at one.
      const state = { failedAttempts: 1, lockedUntil: null };
      await updateDocFields(path, { ...state, updatedAt: new Date(nowMs).toISOString() });
      return state;
    }
    await inc(path, { failedAttempts: 1 }, { updatedAt: new Date(nowMs).toISOString() });
    const fresh = await getDoc(path);
    const count = Math.max(1, Number(fresh?.failedAttempts) || 1);
    const lockedUntil = lockFromCount(count, nowMs);
    if (lockedUntil && !(fresh?.lockedUntil && Date.parse(fresh.lockedUntil) > nowMs)) {
      await updateDocFields(path, { lockedUntil });
    }
    return { failedAttempts: count, lockedUntil: lockedUntil || fresh?.lockedUntil || null };
  }
  const state = nextFailureState(doc, nowMs);
  await updateDocFields(path, { ...state, updatedAt: new Date(nowMs).toISOString() });
  return state;
}

export async function recordLoginSuccess(doc: UserDoc, nowMs = Date.now(), extra: Record<string, any> = {}): Promise<void> {
  await updateDocFields(`${USERS}/${doc.username}`, {
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: new Date(nowMs).toISOString(),
    ...extra,
  });
}

export function newUserDoc(args: {
  username: string; displayName: string; email: string | null; role: Role; passwordHash: string;
  mustChangePassword: boolean; createdBy: string; nowMs?: number;
}): UserDoc {
  const now = new Date(args.nowMs ?? Date.now()).toISOString();
  return {
    username: args.username,
    displayName: args.displayName || args.username,
    email: args.email,
    role: normalizeRole(args.role),
    active: true,
    passwordHash: args.passwordHash,
    tokenVersion: 0,
    failedAttempts: 0,
    lockedUntil: null,
    mustChangePassword: !!args.mustChangePassword,
    resetTokenHash: null,
    resetExpiresAt: null,
    resetRequestedAt: null,
    createdAt: now,
    createdBy: args.createdBy,
    updatedAt: null,
    lastLoginAt: null,
    passwordChangedAt: now,
  };
}
