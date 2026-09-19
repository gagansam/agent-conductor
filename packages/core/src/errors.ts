/** A mistake in what the operator asked for, not a bug: the CLI prints the message without a stack trace. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
