/** Controls the sidecar's candidate-file writer; absent means proposals are off. */
export interface CairnObserverProposalOptions {
    /** Worker-view `<stateDir>/proposals`; the scheduler ingests it at task finish. */
    dir: string
    projectId: string
    taskId: string
    allowedKinds: string[]
    maxPerTask: number
    maxFileBytes: number
    maxTotalBytes: number
    minConfidence: number
    requireEvidenceForFact: boolean
}

export interface CairnObserverOptions {
    /** Worker-view path to the compact project/focus snapshot written by the scheduler. */
    contextPath: string
    /** Durable, project-level ideas/memory board (shared across tasks). */
    boardDir: string
    /** Task-scoped review queue, rounds, audit, and sidecar session. */
    stateDir: string
    /** model-prefs.json entry; absent means "use the prompt's model". */
    model?: string
    everyRounds: number
    windowRounds: number
    timeoutSeconds: number
    maxReviewsPerTask: number
    /** Candidate graph changes; absent when the control plane disabled proposals. */
    proposals?: CairnObserverProposalOptions
}

export interface CairnObserverHandle {
    /**
     * Waits for queued reviews before the worker writes its result. Never throws and
     * never changes the task result; timeout is logged and the review is abandoned.
     */
    flush(timeoutMs?: number): Promise<void>
}

export interface CairnObserverContextFile {
    version: 1
    project: { id: string; title: string }
    focus: {
        task_id: string
        kind: string
        intent_id: string | null
        intent_description: string | null
    }
    scope: { targets: string[]; notes?: string }
    open_intents: { id: string; description: string; from: string[] }[]
    facts: { id: string; description: string }[]
    hints: { content: string; creator: string; created_at: string }[]
}

export interface CairnReviewRound {
    round: number
    assistant_summary: string
    tool_logs: {
        tool_name: string
        args_summary: string
        result_summary: string
        is_error: boolean
    }[]
}

export interface CairnReviewPayload {
    reason: "periodic" | "agent_end" | "flush"
    rounds: CairnReviewRound[]
}
