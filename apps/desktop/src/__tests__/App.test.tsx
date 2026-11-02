import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import App from '../renderer/App';

// webpack's require.context does not exist under jest.
jest.mock('../renderer/lib/fileIconUrl', () => ({ loadFileIconUrl: async () => null }));

describe('App', () => {
  it('should render', () => {
    expect(render(<App />)).toBeTruthy();
  });
});
