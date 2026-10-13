// Q3 — curated skill TEMPLATE PACKS (client-safe pure data).
//
// A template pack is a bundle-v2 document with a name/description/tags and
// 1-3 custom-skill declarations — the "shareable unit" the P1 bundle format
// was missing. The Templates tab in the skills panel renders these cards
// and imports them through the SAME POST /api/skills/import lane a
// downloaded bundle file takes: a template import is indistinguishable
// from a file import (same validators, same collision semantics with
// rename suggestions, same audit story).
//
// This module is PURE DATA with zero imports — safe for client components
// (the server skills barrel must never cross into a client bundle).
//
// The curated packs below target the LOCAL skill-webhook mini-service
// (port 3030) so the golden path is fully real end-to-end (real HTTP,
// real JSON, real latencies) while staying deterministic — the same
// #51 discipline that made the M3/QA webhook lane reproducible. Template
// cards disclose this in their description; on another instance the
// endpoints need a running webhook target (any echo-style service).

/** A custom-skill declaration in the portable (bundle) shape. */
export interface TemplateSkill {
  skillId: string;
  label: string;
  description: string;
  endpoint: string;
  params: {
    key: string;
    type: "string" | "number" | "boolean" | "json";
    required?: boolean;
    default?: string | number | boolean;
    description: string;
  }[];
  headers?: Record<string, string>;
  latency: "fast" | "slow";
  requires: string[];
  agents: string[];
}

/** One curated pack — maps 1:1 onto a bundle-v2 document. */
export interface SkillTemplatePack {
  id: string;
  name: string;
  description: string;
  tags: string[];
  skills: TemplateSkill[];
}

const WEBHOOK = "http://127.0.0.1:3030";

export const SKILL_TEMPLATE_PACKS: SkillTemplatePack[] = [
  {
    id: "pack-echo-diagnostics",
    name: "Echo Diagnostics",
    description:
      "Two webhook skills for exercising the full custom-skill pipeline: an " +
      "instant echo (fast lane, inline execution) and a 3-second delayed " +
      "echo (slow lane — chat invocations queue it as a background tool job " +
      "with a live-updating card). Targets the local skill-webhook service.",
    tags: ["diagnostics", "queue", "webhook"],
    skills: [
      {
        skillId: "custom.template-echo",
        label: "Template Echo",
        description:
          "Echoes the payload back through the local webhook service — the " +
          "fast-lane golden path for custom skills (inline, ~10ms).",
        endpoint: `${WEBHOOK}/echo`,
        params: [
          {
            key: "message",
            type: "string",
            required: true,
            description: "The text to echo back (verbatim).",
          },
        ],
        latency: "fast",
        requires: [],
        agents: [],
      },
      {
        skillId: "custom.template-slow-echo",
        label: "Template Slow Echo",
        description:
          "Same echo after a deliberate 3-second delay — SLOW latency, so " +
          "agent chats queue it as a background tool job (stoppable, live " +
          "card, audited) instead of blocking the turn.",
        endpoint: `${WEBHOOK}/echo?delay=3000`,
        params: [
          {
            key: "message",
            type: "string",
            required: true,
            description: "The text to echo back after the delay.",
          },
        ],
        latency: "slow",
        requires: [],
        agents: [],
      },
    ],
  },
  {
    id: "pack-failure-lab",
    name: "Failure Lab",
    description:
      "A deliberately failing webhook skill — every invocation returns HTTP " +
      "500, which the skill layer renders as an honest error card and an " +
      "error audit row. For verifying failure paths end-to-end (the model " +
      "is instructed to report the failure, never fake success).",
    tags: ["testing", "errors"],
    skills: [
      {
        skillId: "custom.template-fail",
        label: "Template Deliberate Failure",
        description:
          "Always responds 500 { error: \"boom\" } — the error-path probe " +
          "for custom skills. Agents see an honest failure envelope.",
        endpoint: `${WEBHOOK}/fail`,
        params: [
          {
            key: "message",
            type: "string",
            required: true,
            description: "Ignored by the endpoint — carried for the payload shape.",
          },
        ],
        latency: "fast",
        requires: [],
        agents: [],
      },
    ],
  },
  {
    id: "pack-trusted-headers",
    name: "Trusted Header Echo",
    description:
      "A webhook skill that sends a custom auth header (X-Foundry-Source) " +
      "with every call — the echo endpoint returns the headers it received, " +
      "so one invocation proves the registered headers actually reach the " +
      "target service.",
    tags: ["webhook", "headers", "auth"],
    skills: [
      {
        skillId: "custom.template-headered-echo",
        label: "Template Headered Echo",
        description:
          "Echo with a registered custom header — the response's `headers` " +
          "field shows exactly what arrived, proving header injection.",
        endpoint: `${WEBHOOK}/echo`,
        params: [
          {
            key: "message",
            type: "string",
            required: true,
            description: "The text to echo back.",
          },
        ],
        headers: { "X-Foundry-Source": "skill-template-pack" },
        latency: "fast",
        requires: [],
        agents: [],
      },
    ],
  },
];

/** Build the bundle-v2 import document for one pack (the exact shape
 *  POST /api/skills/import consumes — same lane as a downloaded file). */
export function packToBundleDoc(pack: SkillTemplatePack): Record<string, unknown> {
  return {
    kind: "foundry-lab-skill-bundle",
    version: 2,
    exportedAt: new Date(0).toISOString(), // template, not an export
    metadata: {
      name: pack.name,
      ...(pack.description ? { description: pack.description } : {}),
      ...(pack.tags.length > 0 ? { tags: pack.tags } : {}),
    },
    skills: pack.skills.map((s) => ({
      skillId: s.skillId,
      label: s.label,
      description: s.description,
      endpoint: s.endpoint,
      params: s.params,
      ...(s.headers ? { headers: s.headers } : {}),
      latency: s.latency,
      requires: s.requires,
      agents: s.agents,
    })),
  };
}
