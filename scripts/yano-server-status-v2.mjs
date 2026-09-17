// Reload-safe entrypoint. Pi may retain the original ESM module during /reload;
// the versioned URL forces the implementation to be evaluated again.
const implementationUrl = new URL("./yano-server-status.mjs", import.meta.url);
implementationUrl.searchParams.set("runtime", "v2");
const implementation = await import(implementationUrl.href);
export const discoverServerEndpoints = implementation.discoverServerEndpoints;
export const probeServer = implementation.probeServer;
export const discoverAndProbeServers = implementation.discoverAndProbeServers;
