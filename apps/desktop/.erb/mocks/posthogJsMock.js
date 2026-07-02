// posthog-js ships pure-ESM bundles (`dist/module.full.no-external` and the
// `dist/posthog-recorder` side-effect import) that ts-jest's CommonJS
// transform can't parse — node_modules isn't transformed. Tests don't
// exercise analytics (capture is gated on a configured key, which CI never
// sets), so stub the client with no-op methods. Real runtime uses webpack,
// which bundles the ESM cleanly.
const noop = () => undefined;

const posthog = {
  init: noop,
  identify: noop,
  reset: noop,
  capture: noop,
  register: noop,
  captureException: noop,
  group: noop,
  setPersonProperties: noop,
  opt_in_capturing: noop,
  opt_out_capturing: noop,
  startSessionRecording: noop,
  stopSessionRecording: noop,
};

module.exports = posthog;
module.exports.default = posthog;
