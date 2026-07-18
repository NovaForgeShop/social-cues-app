import type { ModeratorPermission } from '@devvit/web/server';
import type { ModerationAction, ModerationCapabilities } from '../../shared/api';

const requiredPermissions: Record<ModerationAction, readonly ModeratorPermission[]> = {
  approve: ['posts'],
  remove: ['posts'],
  spam: ['posts'],
  lock: ['posts'],
  unlock: ['posts'],
};

export function canPerformModerationAction(
  action: ModerationAction,
  permissions: readonly ModeratorPermission[]
): boolean {
  return permissions.includes('all') || requiredPermissions[action].some((permission) => permissions.includes(permission));
}

export function getModerationCapabilities(
  permissions: readonly ModeratorPermission[]
): ModerationCapabilities {
  return {
    approve: canPerformModerationAction('approve', permissions),
    remove: canPerformModerationAction('remove', permissions),
    spam: canPerformModerationAction('spam', permissions),
    lock: canPerformModerationAction('lock', permissions),
    unlock: canPerformModerationAction('unlock', permissions),
  };
}

export function moderationPermissionError(action: ModerationAction): string {
  return `The ${action} action requires the Reddit posts moderator permission.`;
}
