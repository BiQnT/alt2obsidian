// Test entry: Alt local sources, plate-json conversion, note status (obsidian stubbed).
export * from "../../src/sources/index";
export { AltLocalApiSource, probeAltStatus, altHasNoteRoutes } from "../../src/sources/AltLocalApiSource";
export { AltLocalDbSource, checkSchema, AltDbError, KNOWN_SCHEMA_VERSIONS, RUNNING_COPY_MAX_AGE_MS, storeStamp } from "../../src/sources/AltLocalDbSource";
export { dbCandidates, readHttpServerConfig, tokenFilePath, ALT_DEFAULT_PORT } from "../../src/sources/altPaths";
export { parseTranscript, pickSlides, folderChain, bundleFromRows, detailsFromComponents } from "../../src/sources/altRows";
export { plateToMarkdown, componentTextToMarkdown } from "../../src/sources/plateToMarkdown";
export { untimedSegments, bundleFromAltData } from "../../src/sources/AltPublicUrlSource";
export * from "../../src/core/noteStatus";
export { parseLsof, parseProcNetTcp, parseNetstat, parseTasklist, isAltExecutable, systemOwnerVerifier } from "../../src/sources/altOwnership";
export { isSameWindowsUser } from "../../src/sources/altOwnership";
