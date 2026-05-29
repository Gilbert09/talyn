import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { renderMarkdownish, Markdown } from '../renderer/lib/markdown';

// react-markdown (and its plugin tree) are ESM and mocked in jest (see
// .erb/mocks/reactMarkdownMock.js) — the stub surfaces the raw text.
// Markdown correctness is covered by react-markdown's own test suite;
// here we just verify our wrapper passes content through for both
// variants and the legacy helper stays a thin shim over <Markdown />.

describe('Markdown wrapper', () => {
  it('renders the provided text (surface variant)', () => {
    const { getByText } = render(<Markdown text="hello **world**" variant="surface" />);
    expect(getByText(/hello/)).toBeInTheDocument();
  });

  it('renders the provided text (feed variant, the default)', () => {
    const { getByText } = render(<Markdown text="agent output" />);
    expect(getByText(/agent output/)).toBeInTheDocument();
  });

  it('renderMarkdownish returns a <Markdown /> element wrapping the text', () => {
    const { getByText } = render(<div>{renderMarkdownish('legacy call site')}</div>);
    expect(getByText(/legacy call site/)).toBeInTheDocument();
  });
});
