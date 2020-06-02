/* global module */
module.exports = {
  // parser: "babel-eslint",
  extends: ['airbnb-base', 'plugin:prettier/recommended'],
  env: {
    es6: true, // supports new ES6 globals (e.g., new types such as Set)
  },
  rules: {
    'implicit-arrow-linebreak': 'off',
    'function-paren-newline': 'off',
    'arrow-parens': 'off',
    strict: 'off',
    'no-else-return': 'off',
    'no-lonely-if': 'off',
    'prefer-destructuring': 'off',
    'no-console': 'off',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-return-assign': 'off',
    'no-param-reassign': 'off',
    'no-restricted-syntax': ['off', 'ForOfStatement'],
    'no-unused-expressions': 'off',
    'no-loop-func': 'off',
    'yoda': ['error', 'never', { 'exceptRange': true }],
    'import/prefer-default-export': 'off', // contrary to Agoric standard
  },
  globals: {
    'BigInt': 'readonly',
  },
};
