import "dotenv/config";

// In-memory cache: workspaceMemberId -> clinicId
let cache: Record<string, string | null> = {};
let lastFetchTime = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Gets the clinicId assigned to a workspace member.
 * Automatically refreshes the cache from Twenty CRM if it is older than 60 seconds.
 */
export async function getWorkspaceMemberClinic(userId: string): Promise<string | null> {
  if (Date.now() - lastFetchTime > CACHE_TTL_MS) {
    await refreshCache();
  }
  return cache[userId] || null;
}

/**
 * Refreshes the Workspace Members cache by querying Twenty CRM via GraphQL.
 */
async function refreshCache() {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  
  if (!apiKey) {
    console.error("[WorkspaceCache] TWENTY_API_KEY is not set. Cannot fetch workspace members.");
    return;
  }

  // Convert REST URL to GraphQL URL
  const graphqlUrl = apiUrl.replace("/rest", "/graphql");
  
  const query = `
    query {
      workspaceMembers(first: 200) {
        edges {
          node {
            id
            name { firstName lastName }
            clinic {
              id
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });
    
    if (!res.ok) {
      console.error(`[WorkspaceCache] Failed to fetch workspace members (${res.status}):`, await res.text());
      return;
    }
    
    const data = await res.json();
    const members = data?.data?.workspaceMembers?.edges || [];
    
    const newCache: Record<string, string | null> = {};
    for (const edge of members) {
      const node = edge.node;
      if (node) {
        newCache[node.id] = node.clinic?.id || null;
      }
    }
    
    cache = newCache;
    lastFetchTime = Date.now();
    console.log(`[WorkspaceCache] Refreshed dynamically! Mapped ${Object.keys(cache).length} workspace members.`);
  } catch (err) {
    console.error("[WorkspaceCache] Error refreshing cache:", err);
  }
}

/**
 * Manually force a cache clear (useful for webhooks/admin overrides)
 */
export function clearWorkspaceCache() {
  cache = {};
  lastFetchTime = 0;
  console.log("[WorkspaceCache] Cache manually cleared.");
}
