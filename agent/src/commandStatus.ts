/** Closed control-plane diagnostics. Never retain provider text or signed inputs. */
export type CommandStatusCode =
  | "command-lease-unavailable"
  | "command-authorization-rejected"
  | "control-plane-rate-limited"
  | "control-plane-unavailable"
  | "control-plane-timeout"
  | "control-plane-network-failed"
  | "control-plane-response-invalid"
  | "control-plane-unexpected";
export class CommandStatusError extends Error {
  constructor(readonly code: CommandStatusCode) {
    super(`Command status could not be established (${code}).`);
    this.name = "CommandStatusError";
  }
}
