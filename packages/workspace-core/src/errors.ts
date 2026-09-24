export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
