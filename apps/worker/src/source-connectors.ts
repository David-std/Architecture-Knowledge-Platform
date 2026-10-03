import type { SourceConnectorPort } from "@akp/domain";
import {
  GitKnowledgeStore,
  LocalGitSourceConnector,
  type LocalGitSourceConnectorOptions,
} from "@akp/git-store";

export function localGitSourceConnector(
  store: GitKnowledgeStore,
  options?: LocalGitSourceConnectorOptions,
): SourceConnectorPort {
  return new LocalGitSourceConnector(store, options);
}

export {
  JiraCloudSourceConnector,
  LinearSourceConnector,
  type JiraCloudSourceConnectorOptions,
  type LinearSourceConnectorOptions,
  type ProviderHealth,
  type ProviderHealthState,
} from "./external-work-connectors.js";
