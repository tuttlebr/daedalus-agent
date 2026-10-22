module.exports = {
  trailingComma: 'all',
  singleQuote: true,
  // The offline skill evaluator reads the strict JSON subset of YAML.
  overrides: [
    {
      files: [
        '../skills/*/evals/**/*.yaml',
        '../tools/skill-eval/heldout/**/*.yaml',
      ],
      options: { parser: 'json' },
    },
  ],
  plugins: [
    'prettier-plugin-tailwindcss',
    '@trivago/prettier-plugin-sort-imports',
  ],
  importOrder: [
    'react', // React
    '^react-.*$', // React-related imports
    '^next', // Next-related imports
    '^next-.*$', // Next-related imports
    '^next/.*$', // Next-related imports
    '^.*/hooks/.*$', // Hooks
    '^.*/services/.*$', // Services
    '^.*/utils/.*$', // Utils
    '^.*/types/.*$', // Types
    '^.*/pages/.*$', // Components
    '^.*/components/.*$', // Components
    '^[./]', // Other imports
    '.*', // Any uncaught imports
  ],
  importOrderSeparation: true,
};
