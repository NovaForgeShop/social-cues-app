import { redis } from '@devvit/web/server';

export type SignalKind = 'comment' | 'report';

export function commandThreadKey(postId: string): string {
  return `social-cues:command-thread:${postId}`;
}

export function signalCountKey(postId: string, kind: SignalKind): string {
  return `social-cues:signals:${postId}:${kind}`;
}

export function lastSignalKey(postId: string): string {
  return `social-cues:signals:${postId}:last`;
}

export async function registerCommandThread(postId: string): Promise<void> {
  await redis.set(commandThreadKey(postId), new Date().toISOString());
}

export async function isRegisteredCommandThread(postId: string): Promise<boolean> {
  return Boolean(await redis.get(commandThreadKey(postId)));
}

export async function requireRegisteredCommandThread(postId: string): Promise<void> {
  if (!(await isRegisteredCommandThread(postId))) {
    throw new Error('This post is not a registered Social Cues command thread.');
  }
}
