export interface AddResult {
    id: string
    rejected?: string
}

export interface HostRuntimeSettings {
    image?: string
    env?: Record<string, string>
    solverEnv?: Record<string, string>
    binds?: string[]
    maxSolvers?: number
    networkMode?: "bridge" | "host"
}

export interface HostChallengeSettings {
    mockEnabled?: boolean
    apiBaseUrl?: string
    agentToken?: string
    answerModeEnabled?: boolean
    baseUrlMappings?: Array<{
        sourceBaseUrl: string
        gatewayBaseUrl: string
    }>
}

export interface HostPlannerSettings {
    enabled?: boolean
    strategy?: string
    tickIntervalMs?: number
    staleTimeoutMs?: number
}

export interface HostSettings {
    runtime: HostRuntimeSettings
    challenge: HostChallengeSettings
    planner: HostPlannerSettings
}
