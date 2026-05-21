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

function getRedisClient(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: true,
    });

    redisClient.on("error", (err) => {
      console.error("[RoundRobin] Redis connection error:", err.message);
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
  const value = await redis.get(`rr:clinic:${clinicId}`);
  return value ? parseInt(value, 10) : null;
}

/**
 * Reset the round-robin counter for a clinic (for testing or admin purposes).
 */
export async function resetRoundRobin(clinicId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`rr:clinic:${clinicId}`);
  console.log(`[RoundRobin] Counter reset for clinic: ${clinicId}`);
}
