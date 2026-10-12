// Custom-skill registration validation (N2 extraction — was inline in
// POST /api/skills). POST and PATCH /api/skills/:skillId must accept the
// SAME shapes with the SAME rules, so the validators live here and both
// routes import them. Every rule has a matching QA case.

import type { SkillParamDef } from "./types";

export const PARAM_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;
export const SKILL_ID_RE = /^custom\.[a-z0-9][a-z0-9_-]{0,39}$/;
export const PARAM_TYPES = new Set(["string", "number", "boolean", "json"]);
export const MAX_PARAMS = 6;
/** N1: the execution policy a custom skill is registered with. */
export const LATENCIES = new Set(["fast", "slow"]);

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "skill";
}

export function validateParamDefs(raw: unknown): {
  params?: SkillParamDef[];
  error?: string;
} {
  if (raw === undefined || raw === null) return { params: [] };
  if (!Array.isArray(raw)) {
    return { error: "params must be an array of param definitions" };
  }
  if (raw.length > MAX_PARAMS) {
    return { error: `at most ${MAX_PARAMS} params are allowed` };
  }
  const out: SkillParamDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "each param must be an object" };
    }
    const p = item as Record<string, unknown>;
    const key = typeof p.key === "string" ? p.key : "";
    if (!PARAM_KEY_RE.test(key)) {
      return { error: `param key "${key || "(missing)"}" must match ${PARAM_KEY_RE}` };
    }
    if (seen.has(key)) return { error: `duplicate param key "${key}"` };
    seen.add(key);
    const type = typeof p.type === "string" ? p.type : "";
    if (!PARAM_TYPES.has(type)) {
      return { error: `param "${key}": type must be string|number|boolean|json` };
    }
    const description =
      typeof p.description === "string" ? p.description.trim() : "";
    if (!description || description.length > 200) {
      return { error: `param "${key}": description is required (≤200 chars)` };
    }
    const def: SkillParamDef = {
      key,
      type: type as SkillParamDef["type"],
      description,
    };
    if (p.required === true) def.required = true;
    if (typeof p.default === "string" || typeof p.default === "number" || typeof p.default === "boolean") {
      def.default = p.default;
    }
    if (type === "number") {
      if (p.min !== undefined) {
        if (typeof p.min !== "number") return { error: `param "${key}": min must be a number` };
        def.min = p.min;
      }
      if (p.max !== undefined) {
        if (typeof p.max !== "number") return { error: `param "${key}": max must be a number` };
        def.max = p.max;
      }
    }
    out.push(def);
  }
  return { params: out };
}

export function validateHeaders(raw: unknown): {
  headers?: Record<string, string>;
  error?: string;
} {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "headers must be an object" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 8) {
    return { error: "at most 8 header entries are allowed" };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k) || k.length > 60) {
      return { error: `invalid header name "${k}"` };
    }
    if (typeof v !== "string" || v.length > 500) {
      return { error: `header "${k}" value must be a string (≤500 chars)` };
    }
    out[k] = v;
  }
  return { headers: out };
}

/** N1: "fast" | "slow" — anything else is a 400 (unknown latency classes
 *  would silently route invocations down the wrong lane). */
export function validateLatency(raw: unknown): {
  latency?: "fast" | "slow";
  error?: string;
} {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !LATENCIES.has(raw)) {
    return { error: `latency must be "fast" or "slow" (got ${JSON.stringify(raw)})` };
  }
  return { latency: raw as "fast" | "slow" };
}

/** Endpoint shape: http(s) URL, ≤2000 chars. Returns the TRIMMED endpoint. */
export function validateEndpoint(raw: unknown): {
  endpoint?: string;
  error?: string;
} {
  const endpoint = typeof raw === "string" ? raw.trim() : "";
  if (!raw) return { error: "endpoint is required (http/https URL, ≤2000 characters)" };
  if (endpoint.length > 2000) {
    return { error: "endpoint is required (http/https URL, ≤2000 characters)" };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    return { error: `endpoint "${endpoint}" is not a valid URL` };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { error: "endpoint must use http or https" };
  }
  return { endpoint };
}

export function validateLabel(raw: unknown): {
  label?: string;
  error?: string;
} {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label || label.length > 80) {
    return { error: "label is required (1–80 characters)" };
  }
  return { label };
}

export function validateDescription(raw: unknown): {
  description?: string;
  error?: string;
} {
  const description = typeof raw === "string" ? raw.trim() : "";
  if (!description || description.length > 400) {
    return { error: "description is required (1–400 characters)" };
  }
  return { description };
}
