// ESM-only rehype-sanitize. Stubbed for jest: a no-op default plugin plus
// an empty `defaultSchema` named export (markdown.tsx spreads it).
function noopPlugin() {}
module.exports = noopPlugin;
module.exports.default = noopPlugin;
module.exports.defaultSchema = { tagNames: [], attributes: {} };
