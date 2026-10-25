export interface ChallengeApiEnvelope<T> {
    code: number
    message: string
    data: T
}

export interface ChallengeApiChallenge {
    title: string
    code: string
    difficulty: string
    description: string
    level: number
    total_score: number
    total_got_score: number
    flag_count: number
    flag_got_count: number
    hint_viewed: boolean
    instance_status: string
    entrypoint: string[] | null
}

export interface ChallengeApiListData {
    current_level: number
    total_challenges: number
    solved_challenges: number
    challenges: ChallengeApiChallenge[]
}

export interface ChallengeApiSubmitData {
    correct: boolean
    message: string
    flag_count: number
    flag_got_count: number
}

export interface ChallengeApiHintData {
    code: string
    hint_content: string | null
}

export type ChallengeApiStartData = string[] | { already_completed: boolean }

const CHALLENGE_API_MAX_REQUESTS_PER_SECOND = 3
const CHALLENGE_API_REQUEST_INTERVAL_MS = Math.ceil(1000 / CHALLENGE_API_MAX_REQUESTS_PER_SECOND)
const CHALLENGE_API_REQUEST_TIMEOUT_MS = 2_500

type ChallengeApiMockState = {
    listChallenges: () => Promise<ChallengeApiListData>
    startChallenge: (code: string) => Promise<ChallengeApiStartData>
    stopChallenge: (code: string) => Promise<null>
    submitFlag: (code: string, flag: string) => Promise<ChallengeApiSubmitData>
    getHint: (code: string) => Promise<ChallengeApiHintData>
}

function requireText(value: string | undefined, fieldName: string): string {
    const text = value?.trim() ?? ""
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function stripTrailingSlash(value: string): string {
    return value.endsWith("/") ? value.slice(0, -1) : value
}

function normalizeBaseUrl(value: string): string {
    const baseUrl = stripTrailingSlash(requireText(value, "baseUrl"))
    return baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`
}

function formatRequestError(error: unknown): string {
    if (error instanceof Error) {
        const message = error.message.trim()
        return message || error.name
    }
    return String(error)
}

export class ChallengeApiClient {
    readonly baseUrl: string
    readonly agentToken: string
    private readonly mockState?: ChallengeApiMockState
    private nextRequestAt = 0
    private schedule = Promise.resolve()

    private constructor(baseUrl: string, agentToken: string, mockState?: ChallengeApiMockState) {
        this.baseUrl = normalizeBaseUrl(baseUrl)
        this.agentToken = requireText(agentToken, "agentToken")
        this.mockState = mockState
    }

    static create(baseUrl: string, agentToken: string): ChallengeApiClient {
        return new ChallengeApiClient(baseUrl, agentToken)
    }

    static createMock(mockState: ChallengeApiMockState): ChallengeApiClient {
        return new ChallengeApiClient("mock://challenge-api", "mock-agent-token", mockState)
    }

    async listChallenges(): Promise<ChallengeApiListData> {
        return this.runLimited(() => {
            if (this.mockState) return this.mockState.listChallenges()
            return this.request<ChallengeApiListData>("/challenges", "GET")
        })
    }

    async startChallenge(code: string): Promise<ChallengeApiStartData> {
        return this.runLimited(() => {
            if (this.mockState) return this.mockState.startChallenge(requireText(code, "code"))
            return this.request<ChallengeApiStartData>("/start_challenge", "POST", { code: requireText(code, "code") })
        })
    }

    async stopChallenge(code: string): Promise<null> {
        return this.runLimited(() => {
            if (this.mockState) return this.mockState.stopChallenge(requireText(code, "code"))
            return this.request<null>("/stop_challenge", "POST", { code: requireText(code, "code") })
        })
    }

    async submitFlag(code: string, flag: string): Promise<ChallengeApiSubmitData> {
        return this.runLimited(() => {
            if (this.mockState) return this.mockState.submitFlag(requireText(code, "code"), requireText(flag, "flag"))
            return this.request<ChallengeApiSubmitData>("/submit", "POST", {
                code: requireText(code, "code"),
                flag: requireText(flag, "flag"),
            })
        })
    }

    async getHint(code: string): Promise<ChallengeApiHintData> {
        return this.runLimited(() => {
            if (this.mockState) return this.mockState.getHint(requireText(code, "code"))
            return this.request<ChallengeApiHintData>("/hint", "POST", { code: requireText(code, "code") })
        })
    }

    private async request<T>(path: string, method: "GET" | "POST", payload?: Record<string, unknown>): Promise<T> {
        const headers: Record<string, string> = {
            "Agent-Token": this.agentToken,
        }
        const requestInit: RequestInit = {
            method,
            headers,
        }
        if (payload) {
            headers["Content-Type"] = "application/json"
            requestInit.body = JSON.stringify(payload)
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => {
            controller.abort()
        }, CHALLENGE_API_REQUEST_TIMEOUT_MS)

        let response: Response
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                ...requestInit,
                signal: controller.signal,
            })
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error(`challenge api ${method} ${path} timeout after ${CHALLENGE_API_REQUEST_TIMEOUT_MS}ms`)
            }
            throw new Error(`challenge api ${method} ${path} request failed: ${formatRequestError(error)}`)
        } finally {
            clearTimeout(timeout)
        }

        let envelope: ChallengeApiEnvelope<T> | undefined
        try {
            envelope = (await response.json()) as ChallengeApiEnvelope<T>
        } catch {
            if (!response.ok) {
                throw new Error(`challenge api ${method} ${path} failed with HTTP ${response.status}`)
            }
            throw new Error(`challenge api ${method} ${path} returned invalid json`)
        }

        if (!response.ok) {
            const message = envelope?.message?.trim() || `HTTP ${response.status}`
            throw new Error(`challenge api ${method} ${path} failed: ${message}`)
        }

        if (!envelope || typeof envelope !== "object") {
            throw new Error(`challenge api ${method} ${path} returned invalid response`)
        }
        if (envelope.code !== 0) {
            const message = envelope.message?.trim() || "unknown error"
            throw new Error(`challenge api ${method} ${path} failed: ${message}`)
        }
        return envelope.data
    }

    private async runLimited<T>(run: () => Promise<T>): Promise<T> {
        await this.waitForRateLimitWindow()
        return run()
    }

    private async waitForRateLimitWindow(): Promise<void> {
        let release!: () => void
        const ready = new Promise<void>((resolve) => {
            release = resolve
        })
        const previous = this.schedule
        this.schedule = (async () => {
            await previous
            const now = Date.now()
            const waitMs = Math.max(0, this.nextRequestAt - now)
            if (waitMs > 0) await Bun.sleep(waitMs)
            this.nextRequestAt = Math.max(this.nextRequestAt, Date.now()) + CHALLENGE_API_REQUEST_INTERVAL_MS
            release()
        })()
        await ready
    }
}
