// An error whose status the HTTP handler sends to the client instead of 500.
export function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
