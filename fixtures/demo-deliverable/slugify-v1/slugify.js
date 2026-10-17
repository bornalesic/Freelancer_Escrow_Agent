/** Turns text into a URL-friendly slug. */
export function slugify(text) {
  return text.trim().toLowerCase().replace(/\s+/g, '-');
}
