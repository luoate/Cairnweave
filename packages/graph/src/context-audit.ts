/** Diagnostic metadata emitted by the actual selectors, never part of model-facing YAML. */
export interface ContextSelection {
  section: string;
  scope: "project" | "focus" | "since_last_reason";
  candidates: number;
  selected: number;
  /** Names and values of the limits used by this selector (not a token budget). */
  limits: Record<string, number>;
  policy: string;
}

export interface AgentContextAudit {
  selections: ContextSelection[];
  details: {
    max_chars: number;
    examined_fields: number;
    clipped_fields: number;
  };
}

export interface GraphExportAudit {
  sliced: boolean;
  selections: ContextSelection[];
  /** Existing YAML slice flag; not the same as project-wide coverage. */
  legacy_truncated: boolean;
  mandatory_over_cap: boolean;
}
