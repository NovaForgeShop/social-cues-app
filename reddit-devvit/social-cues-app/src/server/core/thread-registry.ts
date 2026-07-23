import { redis } from '@devvit/web/server';

export type SignalKind = 'comment' | 'report';

export const COMMAND_THREAD_POST_DATA = {
  kind: 'social-cues-community-command',
  version: 1,
} as const;

export function hasCommandThreadPostData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const postData = value as Record<string, unknown>;
  return postData.kind === COMMAND_THREAD_POST_DATA.kind && postData.version === COMMAND_THREAD_POST_DATA.version;
}

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
