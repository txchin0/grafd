export { getBlockProp, setBlockProp } from './block-props.js';
export {
  syncInheritsForMember,
  syncInheritsForMembers,
  syncInheritsForPath,
  readableContextsForChildPath,
  sameNameSet,
  type InheritsSyncDeps,
} from './inherits.js';
export {
  renameContextAcrossWorkspace,
  documentReferencesContext,
  type WorkspaceRenameDeps,
} from './workspace-rename.js';
export {
  createContextOrchestration,
  membersUpdatingRegion,
  NEW_REGION_NAME,
  type ContextOrchestration,
  type ContextOrchestrationOptions,
  type CreationTarget,
  type ExtractionTarget,
} from './orchestration.js';
