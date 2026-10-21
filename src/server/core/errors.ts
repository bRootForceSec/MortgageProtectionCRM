/** A mistake the user can fix (bad input, a missing record, a conflict). The HTTP error handler sends it as `{ error }` with `status`. */
export class DomainError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
