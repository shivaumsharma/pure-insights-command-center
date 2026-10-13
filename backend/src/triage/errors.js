// Errors a model-backed triager may throw. The service turns any of these into a fall back to the rule-based triager, and the
// message is safe to show: it never repeats what the provider said, so a key or a request echo cannot leak through it.

export class TriageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
