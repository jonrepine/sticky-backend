/**
 * Generates a URL-safe slug from arbitrary user input.
 *
 * Used for tag deduplication: two tags are considered the same if they produce
 * the same slug (e.g. "Machine Learning" and "machine-learning"). The slug is
 * stored alongside the display name so lookups are always case-insensitive.
 */
function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

module.exports = {
  slugify
};
