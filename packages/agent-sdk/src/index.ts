export type {
  AgentDefinition,
  AgentRunRequest,
  AgentRunResult,
  EvidenceItem,
  AgentRunJobData,
  ReportGenerationJobData,
} from "./types.js";
export { AGENT_RUN_QUEUE_NAME, REPORT_GENERATION_QUEUE_NAME } from "./types.js";
export { AgentRegistry } from "./registry.js";

// Lead-discovery source connectors (moved here from apps/worker/src/connectors
// so both apps/worker and apps/api can depend on the same connector
// framework/registry without apps/api depending on the apps/worker process
// itself, which has top-level side effects (Redis connection) on import.
// apps/worker/src/connectors/*.ts are now thin re-export shims over this
// package for backwards compatibility with its existing tests/imports.
export type {
  ConnectorConfig,
  ConnectorDiscoveryResult,
  DiscoveredContact,
  DiscoveredOrganization,
  SourceConnector,
} from "./connectors/types.js";
export { SlidingWindowRateLimiter } from "./connectors/rateLimiter.js";
export {
  CsvUploadConnector,
  CsvFormatError,
  CSV_REQUIRED_HEADER,
  parseCsvRecords,
  type CsvConnectorInput,
} from "./connectors/csvConnector.js";
export {
  PublicDirectoryConnector,
  OverpassDirectoryApiClient,
  NotConfiguredDirectoryApiClient,
  NotConfiguredError,
  UnsupportedIndustryError,
  INDUSTRY_TO_OSM_TAG,
  type DirectoryApiClient,
  type RawDirectoryListing,
  type PublicDirectorySearchInput,
} from "./connectors/publicDirectoryConnector.js";
export { getConnector, listConnectors } from "./connectors/registry.js";
