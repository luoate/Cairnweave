/**
 * One credential policy, shared by the task prompts, the solver preamble and the writeup prompt.
 *
 * Two classes must not be confused. Credentials recovered from a target inside the authorized
 * scope are challenge material: a writeup that hides them is not reproducible, and the operator
 * already holds them on the host. The operator's own secrets are the opposite — model API keys,
 * the operator token, the agent config directory and private keys belong to the host and must
 * never reach the graph, an artifact, a task output or a log.
 *
 * Keeping both halves in one module is the point: when the worker is allowed to record a value,
 * the writeup writer must be allowed to copy it, or the draft and the model-written version
 * disagree about the same fact.
 */

/** The artifact filename workers use for recovered target credentials. */
export const CREDENTIAL_FILE_NAME = "credentials.txt";

/** Worker-facing: what to do with a value recovered from an authorized target. */
export const CREDENTIAL_RECORDING_RULE =
  "从授权范围内目标取得的账号、口令、哈希与会话 cookie 属于挑战材料：把每个值逐字写进事实描述，" +
  `并写进 \`artifacts/<任务>/${CREDENTIAL_FILE_NAME}\`，每行一个 \`名称 = 值\`，不要脱敏、打码或改写。`;

/** Worker-facing: what must never be persisted, in any channel. */
export const OPERATOR_SECRET_RULE =
  "操作员自己的机密（模型 API key、operator token、agent 配置、私钥）绝不能出现在描述、证据文件、任务输出或日志里。";

/** Writeup-facing: the writer copies challenge material verbatim and drops host secrets. */
export const CREDENTIAL_WRITEUP_RULE =
  "草稿里授权范围内目标的账号、口令、哈希与会话 cookie 属于挑战材料：必须逐字符照抄，不得脱敏、打码或改写；" +
  "操作员自己的机密（模型 API key、operator token、agent 配置、私钥）与内网敏感地址不得写入。";
