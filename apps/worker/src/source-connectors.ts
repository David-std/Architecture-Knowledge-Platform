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
