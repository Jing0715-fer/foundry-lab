// Skill layer barrel. Server consumers import from here; the catalog
// self-registers on first import (side-effect import).
//
// Client-safe subset: skills/prompt.ts + skills/types.ts import NOTHING
// server-side — import those directly from client components.

import "./catalog";

export * from "./types";
export { registerSkill, getSkill, listSkills, catalogEntries, resolveSkillId, skillsForAgent } from "./registry";
export { runSkill, skipSkill, recordSkillInvocation, skillFeedback, validateParams } from "./runner";
export { renderSkillManifest } from "./prompt";
export { extractSkillCalls, type SkillCall, type SkillFence } from "./fences";
