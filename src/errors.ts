export class SkippedCandidateError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "SkippedCandidateError";
  }
}
