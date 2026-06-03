/**
 * Redis-backed Round-Robin Counter
 *
 * Uses Redis INCR (atomic increment) to assign the next manager index
 * for a given clinicId. This is race-condition safe — multiple simultaneous
 * lead submissions won't pick the same manager.
 *
 * Redis key pattern: rr:clinic:{clinicId}
 * The counter increments forever; we use modulo to wrap around.
 */

import Redis from "ioredis";

let redisClient: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (!redisClient) {
    if (!process.env.REDIS_URL) {
      console.warn("[ioredis] REDIS_URL not set. Running in stateless local mode.");
      return null;
    }
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    redisClient.on("error", (err) => {
      console.error("[ioredis] Error:", err.message);
    });
  }
  return redisClient;
}

/**
 * Returns the index of the next manager to assign for a given clinic.
 *
 * @param clinicId - The clinic's unique identifier
 * @param totalManagers - Total number of managers available for this clinic
 * @returns Index (0-based) of the manager to assign next
 */
export async function getNextManagerIndex(
  clinicId: string,
  totalManagers: number
): Promise<number> {
  if (totalManagers <= 0) {
    throw new Error(`[RoundRobin] No managers available for clinic: ${clinicId}`);
  }

  const redis = getRedisClient();
  if (!redis) {
    // Stateless fallback: pick random index if Redis isn't running
    return Math.floor(Math.random() * totalManagers);
  }
  
  const key = `rr:clinic:${clinicId}`;

  // INCR is atomic — safe under concurrent requests
  const counter = await redis.incr(key);

  // Modulo wraps the counter into a valid index (0 to totalManagers-1)
  return (counter - 1) % totalManagers;
}

/**
 * Inspect the current round-robin counter for a clinic (for debugging).
 */
export async function getRoundRobinState(clinicId: string): Promise<number | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  const value = await redis.get(`rr:clinic:${clinicId}`);
  return value ? parseInt(value, 10) : null;
}

/**
 * Reset the round-robin counter for a clinic (for testing or admin purposes).
 */
export async function resetRoundRobin(clinicId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.del(`rr:clinic:${clinicId}`);
  console.log(`[RoundRobin] Counter reset for clinic: ${clinicId}`);
}

export async function getNextManagerId(clinicId: string, managerIds: string[]): Promise<string | null> {
  if (managerIds.length === 0) return null;
  if (managerIds.length === 1) return managerIds[0];

  const redis = getRedisClient();
  if (!redis) {
    // Stateless fallback: just pick random if Redis isn't running
    return managerIds[Math.floor(Math.random() * managerIds.length)];
  }

  const key = `rr:clinic:${clinicId}:counter`;
  const counter = await redis.incr(key);
  const index = (counter - 1) % managerIds.length;
  
  return managerIds[index];
}

export async function getCurrentManagerId(clinicId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  const value = await redis.get(`rr:clinic:${clinicId}`);
  return value || null;
}
