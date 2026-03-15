/**
 * Sign-in identifier detection and normalization (email vs username).
 * Usernames never contain '@' (enforced at signup).
 */

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;

/** Valid email shape when user chose email path (contains '@'). */
const EMAIL_LIKE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function detectIdentifierType(input) {
  return input.includes('@') ? 'email' : 'username';
}

function isValidUsernameShape(normalized) {
  if (!normalized || normalized.length < USERNAME_MIN || normalized.length > USERNAME_MAX) {
    return false;
  }
  return USERNAME_PATTERN.test(normalized);
}

function isValidEmailShape(raw) {
  return EMAIL_LIKE_PATTERN.test(raw.trim());
}

module.exports = {
  detectIdentifierType,
  isValidUsernameShape,
  isValidEmailShape,
  USERNAME_PATTERN,
  USERNAME_MIN,
  USERNAME_MAX
};
