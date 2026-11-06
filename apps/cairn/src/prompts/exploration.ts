/** M52a/b: explanatory policy for the applied pack only, never a scheduling instruction. */
export const EXPLORATION_MONITOR_INSTRUCTIONS = `

# 重复探索与进展记录（M52a/b，只读提示）
若授权上下文的 intents/attempts 带 exploration，mode=observe_only：plan_fingerprint 比较当前项目/Scope、来源事实和五字段契约；proposal_fingerprint 另比较来源方向和精确观察引用。描述、解释、优先级或去重键的变化不代表实验输入变化；这是确定性匹配，不是语义等价证明。
new_observation 仅表示在可比较的已记录历史中首次出现该行动/观察/result/事实引用报告；repeated_observation、interpretation_only、no_observation 分别表示重复观察报告、仅有解释、没有观察。文件名变化、解释变化或新的检查点版本不算新观察；这不比较证据正文，也不证明目标状态没有变化。
consecutive_without_new_observation 统计可比较结束任务，而非保存次数。环境/执行/工具故障标 operationally_incomplete 且不增加计数；缺记录、缺派发绑定、证据不可用、Scope/计划/事实变化等为 unknown，中断连续性。计数只涉及观察报告，不代表没有新 Fact、没有复验价值或整体路线停滞。
记录可用于说明下一次实验改变了什么、需要补什么观察，并与当前 Fact/目标进展一起考虑。合理复验仍可继续：这些只读字段不要求放弃方向、不自动禁止派发/重试，不改变用户引导、Scope 或完成门禁。控制面只有在单独显式启用 M52c 时才可应用有界排序软降权，不修改存储优先级或预算，字段本身不是抑制命令。hypothesis_verdict 始终 unknown；未交付的记录不是不存在，不自行补造。
`;
