import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { renderMarkdownish } from '../renderer/lib/markdown';

function renderMd(text: string) {
  return render(<div>{renderMarkdownish(text, 'surface')}</div>);
}

describe('renderMarkdownish — GFM tables', () => {
  it('renders a pipe table as a real <table> with header + body cells', () => {
    const { container } = renderMd(
      ['| Name | Status |', '| --- | --- |', '| build | passing |', '| lint | failing |'].join(
        '\n'
      )
    );
    const table = container.querySelector('table');
    expect(table).toBeInTheDocument();
    const headers = container.querySelectorAll('th');
    expect(Array.from(headers).map((h) => h.textContent)).toEqual(['Name', 'Status']);
    const firstRowCells = container.querySelectorAll('tbody tr:first-child td');
    expect(Array.from(firstRowCells).map((c) => c.textContent)).toEqual(['build', 'passing']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('supports alignment colons in the delimiter row', () => {
    const { container } = renderMd(
      ['| a | b |', '| :--- | ---: |', '| 1 | 2 |'].join('\n')
    );
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container.querySelectorAll('th')).toHaveLength(2);
  });

  it('renders inline markdown inside table cells', () => {
    const { container } = renderMd(
      ['| col |', '| --- |', '| **bold** |'].join('\n')
    );
    expect(container.querySelector('td strong')).toHaveTextContent('bold');
  });

  it('does not treat a lone --- as a table (stays a horizontal rule)', () => {
    const { container } = renderMd('---');
    expect(container.querySelector('table')).not.toBeInTheDocument();
    expect(container.querySelector('hr')).toBeInTheDocument();
  });
});

describe('renderMarkdownish — <details>/<summary>', () => {
  it('renders a native <details> with the summary text', () => {
    const { container } = renderMd(
      ['<details>', '<summary>Show more</summary>', '', 'hidden body', '</details>'].join('\n')
    );
    const details = container.querySelector('details');
    expect(details).toBeInTheDocument();
    expect(container.querySelector('summary')).toHaveTextContent('Show more');
    expect(details).toHaveTextContent('hidden body');
  });

  it('renders markdown (incl. tables) inside the details body', () => {
    const { container } = renderMd(
      [
        '<details>',
        '<summary>Report</summary>',
        '',
        '| k | v |',
        '| --- | --- |',
        '| a | b |',
        '</details>',
      ].join('\n')
    );
    expect(container.querySelector('details table')).toBeInTheDocument();
  });

  it('strips HTML tags from the summary text', () => {
    const { container } = renderMd(
      ['<details>', '<summary><b>Bold</b> title</summary>', 'x', '</details>'].join('\n')
    );
    expect(container.querySelector('summary')).toHaveTextContent('Bold title');
  });

  it('handles an open attribute on the details tag', () => {
    const { container } = renderMd(
      ['<details open>', '<summary>Open</summary>', 'body', '</details>'].join('\n')
    );
    expect(container.querySelector('details')).toBeInTheDocument();
    expect(container.querySelector('summary')).toHaveTextContent('Open');
  });
});
