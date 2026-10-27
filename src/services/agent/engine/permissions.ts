import { eq } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { users } from '../../../db/schema';
import { getConfig } from '../../../config/env';
import { ForbiddenError } from '../../../utils/errors';

export interface UserGrants {
  userId: string;
  permissions: ReadonlySet<string>;
}

/**
 * Resolves what a user may do. Always called by the engine at execution time from trusted
 * server-side state; nothing the model or the request body says can influence it.
 */
export interface PermissionResolver {
  resolve(userId: string): Promise<UserGrants>;
}

/**
 * Default policy: users who completed dual-channel verification receive AGENT_DEFAULT_PERMISSIONS.
 * Replace with a resolver backed by per-user grants when such a model exists.
 */
export class DefaultPermissionResolver implements PermissionResolver {
  async resolve(userId: string): Promise<UserGrants> {
    const [user] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || !user.phoneVerifiedAt || !user.emailVerifiedAt) {
      throw new ForbiddenError('User is not fully verified');
    }
    const granted = getConfig()
      .AGENT_DEFAULT_PERMISSIONS.split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    return { userId, permissions: new Set(granted) };
  }
}
