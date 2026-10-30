export { ConfigManager } from "./config/index"
export type { AddResult } from "./config/index"
export type { ModelConfigEntry, ModelDefinition, ProviderPrefEntry } from "./config/providers/types"
export { RuntimeManager } from "./runtime/runtime"
export { runSolverCli, runSubagentCli, runSolverRpc } from "./solver/cli"
export type { SolverEventListener } from "./solver/cli"
// Merged Cairn: the worker calls the solver session directly instead of RPC.
export { createSolverSession } from "./solver/session"
export type { SolverSession } from "./solver/session"
export { initBuiltinPrompts } from "./config/prompts/index"
export { initBuiltinSkills } from "./config/skills/index"
export { CAIRNWEAVE_HOME_DIR, DEFAULT_CONFIG_DIR, TCH_AGENT_HOME_DIR } from "./config/index"

import { ConfigManager } from "./config/index"
import { ChallengeManager } from "./challenge/manager"
import { createChallengeHostBridgeHandler } from "./challenge/host-bridge-handler"
import { RuntimeManager } from "./runtime/runtime"

export class DaemonManager {
    private static instance: Promise<DaemonManager> | undefined

    readonly config: ConfigManager
    readonly challenge: ChallengeManager
    readonly runtime: RuntimeManager

    private constructor(config: ConfigManager, challenge: ChallengeManager, runtime: RuntimeManager) {
        this.config = config
        this.challenge = challenge
        this.runtime = runtime
    }

    static async getInstance(): Promise<DaemonManager> {
        if (this.instance) return this.instance
        const created = (async () => {
            const config = await ConfigManager.getInstance()
            const challenge = new ChallengeManager(config)
            const runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challenge)])
            challenge.attachRuntime(runtime)
            return new DaemonManager(config, challenge, runtime)
        })()
        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
            }
            throw error
        })
        return this.instance
    }

    async reloadFromConfig(): Promise<void> {
        this.challenge.reloadFromConfig()
        await this.runtime.reloadFromConfig()
    }
}
