/**
 * Auth guard — throws if the request has no valid JWT.
 *
 * Used as the first line of any resolver that requires authentication.
 * Returns `context.user` ({ userId, sessionId }) on success.
 * The error message "Authentication required" is matched by test assertions
 * so keep it stable.
 */
function requireUser(context) {
  if (!context.user?.userId) {
    throw new Error('Authentication required');
  }
  return context.user;
}

module.exports = {
  requireUser
};
