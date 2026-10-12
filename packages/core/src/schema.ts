import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KbConfig } from "./config";

export interface TypeDef {
  type: string;
  folder: string; // relative to root, e.g. 200_silver/204_books
  entity: "file" | "folder";
  statuses: string[];
  fields: string[];
  props: Record<string, { type?: string }>;
  schema: Record<string, unknown>;
}

export class SchemaRegistry {
  private ajv: Ajv2020;
  private validators = new Map<string, ValidateFunction>();
  readonly types = new Map<string, TypeDef>();

  constructor(cfg: KbConfig) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: false });
    addFormats(this.ajv);
    const files = readdirSync(cfg.schemas).filter((f) => f.endsWith(".json"));
    const common = JSON.parse(readFileSync(join(cfg.schemas, "_common.json"), "utf8"));
    this.ajv.addSchema(common);
    for (const f of files) {
      if (f.startsWith("_")) continue;
      const schema = JSON.parse(readFileSync(join(cfg.schemas, f), "utf8"));
      const type = f.replace(/\.json$/, "");
      const x = schema["x-kb"] ?? {};
      const props = { ...(common.properties ?? {}), ...(schema.properties ?? {}) };
      this.types.set(type, {
        type,
        folder: x.folder,
        entity: x.entity ?? "file",
        statuses: schema.properties?.status?.enum ?? [],
        fields: Object.keys(props),
        props,
        schema,
      });
      this.validators.set(type, this.ajv.compile(schema));
    }
  }

  get(type: string): TypeDef | undefined {
    return this.types.get(type);
  }

  /** CLI `--set k=v` parses numeric-looking values as numbers; keep them strings when the schema says so (e.g. stock code 1605). */
  coerce(type: string, set: Record<string, unknown>): Record<string, unknown> {
    const props = this.types.get(type)?.props ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) out[k] = props[k]?.type === "string" && typeof v === "number" ? String(v) : v;
    return out;
  }

  /** Returns a list of human-readable errors; empty when valid. */
  validate(fm: Record<string, unknown>): string[] {
    const type = String(fm.type ?? "");
    const v = this.validators.get(type);
    if (!v) return [`unknown type "${type}"`];
    // empty strings / nulls in templates mean "not set yet"; validate as if absent
    const cleaned = Object.fromEntries(Object.entries(fm).filter(([, val]) => val !== "" && val !== null));
    if (v(cleaned)) return [];
    return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  }

  typeForFolder(relPath: string): TypeDef | undefined {
    for (const t of this.types.values()) if (relPath.startsWith(t.folder + "/")) return t;
    return undefined;
  }
}
