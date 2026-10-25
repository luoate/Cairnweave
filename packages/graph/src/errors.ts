/**
 * Cairn's services raise HTTPException directly. The merged graph layer keeps that shape: a
 * status plus a string detail, rendered by the HTTP layer as `{"detail": "..."}`.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "HttpError";
  }
}

export type ValidationLocation = readonly (string | number)[];

export interface ValidationIssue {
  type: string;
  loc: ValidationLocation;
  msg: string;
  input: unknown;
}

/**
 * FastAPI answers request-body validation failures with 422 and a list of issues. The exact
 * pydantic messages are not part of Cairn's client contract, but the status and `detail`
 * envelope are, so this keeps both.
 */
export class RequestValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.msg).join("; ") || "Invalid request");
    this.name = "RequestValidationError";
  }
}
