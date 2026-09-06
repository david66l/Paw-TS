/** Shared Paw Next V3 entry point for embedded hosts. No CLI startup side effects. */
export {
  runFreshPawNextTaskV3,
  runExistingPawNextTaskV3,
  runExistingPawNextWorkSegmentV3,
  type RunFreshPawNextTaskInputV3,
  type PawNextLiveInputV1,
  type PawNextChildControlV1,
} from "./composition.js";
export {
  buildPawNextTaskProfileV3,
  type PawNextProductProfileV3,
  type BuiltPawNextTaskProfileV3,
} from "./product-profile-v3.js";
export { loadPawNextCollaborationRosterV1 } from "./collaboration-roster-adapter.js";

export { projectEnvironmentAcceptance } from "./environment-audit.js";
