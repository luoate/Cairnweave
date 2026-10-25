export type HostBridgeAction =
    | "challenge_get_state"
    | "challenge_get_hint"
    | "challenge_submit_flag"
    | "challenge_is_completed"

export interface HostBridgeRequestEvent {
    type: "host_bridge_request"
    request_id: string
    action: HostBridgeAction
    params: unknown
}
