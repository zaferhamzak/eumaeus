/**
 * Readable text from an HTML email body: scripts and styles dropped, tags
 * removed, common entities decoded, whitespace collapsed. For giving Jev
 * something to read and for short excerpts (rule notifications) — never for
 * displaying the email itself.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
