// react-markdown (and its remark/rehype plugin tree) are pure ESM and
// can't be required by ts-jest's CommonJS transform. The component tests
// don't exercise markdown rendering, so stub it with a div that surfaces
// the raw text. Real runtime uses webpack, which resolves ESM cleanly.
const React = require('react');
function ReactMarkdownMock(props) {
  return React.createElement('div', { 'data-markdown-stub': true }, props.children);
}
module.exports = ReactMarkdownMock;
module.exports.default = ReactMarkdownMock;
