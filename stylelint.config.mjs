export default {
  extends: ['stylelint-config-standard'],
  rules: {
    // It compares the specificity of selectors that match different elements, such as `.button.primary > span` and
    // `.live-label > span`, so nearly every report is about rules that can never conflict.
    'no-descending-specificity': null,
    // Chrome and Safari versions still in use need these prefixes; the unprefixed property follows each one.
    'property-no-vendor-prefix': [
      true,
      { ignoreProperties: ['-webkit-mask', '-webkit-box-decoration-break', '-webkit-background-clip'] },
    ],
  },
};
