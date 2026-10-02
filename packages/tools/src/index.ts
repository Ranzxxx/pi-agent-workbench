export {
  createReadOnlyRepository,
  UnsafeRepositoryPathError,
  type ReadOnlyRepository,
  type ReadOnlyRepositoryOptions,
  type RepositoryFile,
  type SearchMatch,
  type SnapshotFingerprint,
} from "./read-only-repository.js";
export {
  createEvidenceRegistry,
  EvidenceValidationError,
  type EvidenceInput,
  type EvidenceRecord,
} from "./evidence.js";
export {
  fetchPublicGitHubSnapshot,
  SnapshotError,
  type PublicRepositoryInput,
  type SnapshotErrorCode,
  type SnapshotInfo,
  type SnapshotLimits,
  type SnapshotOptions,
} from "./public-github-snapshot.js";
export {
  createProjectFileAccess,
  ProjectFileAccess,
  PROJECT_FILE_LIMITS,
  type ProjectFileChangeKind,
  type ProjectFileContents,
  type ProjectFileEntry,
  type ProjectFileError,
  type ProjectFileJournal,
  type ProjectFileOperationState,
  type ProjectFileSearchMatch,
  type ProjectFileVersion,
} from "./project-files.js";
