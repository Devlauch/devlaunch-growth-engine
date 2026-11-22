/**
 * Re-export shim. The real source-connector framework (SourceConnector
 * interface, ConnectorConfig, DiscoveredOrganization/DiscoveredContact,
 * ConnectorDiscoveryResult) now lives in packages/agent-sdk/src/connectors
 * so apps/api can depend on it directly (as @devlaunch/agent-sdk) without
 * depending on apps/worker itself, which has top-level side effects
 * (Redis connection) on import. This file exists only so apps/worker's own
 * code and existing tests (apps/worker/test/connectors/*.ts) keep working
 * unchanged against "../../src/connectors/types.js".
 */
export type {
  ConnectorConfig,
  ConnectorDiscoveryResult,
  DiscoveredContact,
  DiscoveredOrganization,
  SourceConnector,
} from "@devlaunch/agent-sdk";
