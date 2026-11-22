/**
 * Re-export shim — see types.ts in this directory for why. Real
 * implementation: packages/agent-sdk/src/connectors/registry.ts (same
 * singleton Map instance either way, since both apps/worker and apps/api
 * resolve "@devlaunch/agent-sdk" to the same built package).
 */
export { getConnector, listConnectors } from "@devlaunch/agent-sdk";
