export {
  SCHEMA,
  CairnDatabase,
  all,
  configureDatabase,
  defaultDatabasePath,
  get,
  run,
  type SqlValue,
} from "./db";

export { HttpError, RequestValidationError } from "./errors";
export type { ValidationIssue, ValidationLocation } from "./errors";

export {
  parseCompleteRequest,
  parseConcludeRequest,
  parseCreateHintRequest,
  parseCreateIntentRequest,
  parseCreateProjectRequest,
  parseHeartbeatRequest,
  parseReasonClaimRequest,
  parseReopenRequest,
  parseSettings,
  parseUpdateProjectStatusRequest,
  parseUpdateProjectTitleRequest,
  type CompleteRequest,
  type ConcludeRequest,
  type ConcludeResponse,
  type CreateHintInline,
  type CreateHintRequest,
  type CreateIntentRequest,
  type CreateProjectRequest,
  type EvidenceFileStatus,
  type EvidenceStatus,
  type Fact,
  type FactEvidenceFile,
  type FactMeta,
  type ProjectScopeInput,
  type HeartbeatRequest,
  type Hint,
  type Intent,
  type ProjectDetail,
  type ProjectMeta,
  type ProjectReason,
  type ProjectStatus,
  type ProjectSummary,
  type ReasonClaimRequest,
  type ReopenRequest,
  type ReopenResponse,
  type Run,
  type RunOutcome,
  type Settings,
  type VerifiedFactEvidence,
  type UpdateProjectStatusRequest,
  type UpdateProjectTitleRequest,
} from "./models";

export {
  buildIntents,
  checkProjectActive,
  checkProjectCompleted,
  checkProjectHintWritable,
  clearProjectReason,
  expireReasonLeases,
  expireWorkers,
  getClaimableOpenIntentOr404,
  getCompletionIntentOr409,
  getIntentOr404,
  getIntentTimeout,
  getProjectOr404,
  getReasonTimeout,
  getReleasableOpenIntentOr404,
  intentToModel,
  nextFactId,
  nextHintId,
  nextIntentId,
  nextProjectId,
  nextRunId,
  projectMetaFromRow,
  projectReasonFromRow,
  setUtcNowSource,
  utcnow,
  validateFactsExist,
  validateGoalNotInSources,
  validateIntentCreatorWorker,
  type FactRow,
  type HintRow,
  type IntentRow,
  type ProjectRow,
} from "./services";

export {
  claimReason,
  completeProject,
  concludeIntent,
  createIntent,
  createProject,
  getProjectDetail,
  getProjectScope,
  heartbeatIntent,
  heartbeatReason,
  listProjects,
  releaseIntent,
  releaseReason,
  renewIntentLease,
  renewReasonLease,
  setProjectScope,
  type FactEvidence,
  type ProjectScope,
} from "./commands";

export {
  finishRun,
  getFactMeta,
  listProjectRuns,
  recordFactMeta,
  startRun,
  type FinishRunInput,
  type RecordFactMetaInput,
  type StartRunInput,
} from "./runs";

export {
  listFactEvidence,
  recordFactEvidence,
  type FactEvidenceFileInput,
  type RecordFactEvidenceInput,
} from "./fact-evidence";

export {
  deletePendingConclude,
  getPendingConclude,
  hasPendingConclude,
  isPendingConcludeSession,
  listAllPendingConcludes,
  listPendingConcludes,
  recordPendingConclude,
  type PendingConcludePhase,
  type PendingConcludeRow,
  type RecordPendingConcludeInput,
} from "./pending-concludes";

export { hashFileSha256 } from "./hashing";

export {
  getProjectArtifact,
  listProjectArtifacts,
  recordProjectArtifacts,
  refreshProjectArtifacts,
  type ProjectArtifact,
  type RecordArtifactsOptions,
  type RefreshArtifactsOptions,
} from "./artifacts";

export {
  exportProjectSliceYaml,
  exportProjectTimeline,
  exportProjectYaml,
  formatExportTimestamp,
  loadProjectData,
  type GraphSliceOptions,
  type ProjectData,
} from "./export";

export { emitScalar, map, renderYaml, type YamlMap, type YamlValue } from "./yaml";
