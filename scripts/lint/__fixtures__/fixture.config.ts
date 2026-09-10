const { defineConfig } = require('oxlint')

const localRules = [
  'renderer-boundaries',
  'page-boundaries',
  'utility-process-boundaries',
  'no-export-star',
  'index-no-impl',
  'no-index-tsx',
  'barrel-named-only',
  'barrel-closed',
  'barrel-no-nesting',
  'no-bucket-root-barrel',
  'path-case',
  'no-as-filepath',
  'no-direct-quit',
  'no-template-in-t',
  'prefer-zod-namespace',
  'no-prop-types',
  'dynamic-react-children-map',
  'dynamic-react-clone-element'
]

const reactMigrationRules = {
  'react/button-has-type': 'warn',
  'react/forward-ref-uses-ref': 'warn',
  'react/iframe-missing-sandbox': 'warn',
  'react/jsx-key': ['error', { checkKeyMustBeforeSpread: true, warnOnDuplicates: true, checkFragmentShorthand: true }],
  'react/jsx-no-comment-textnodes': 'warn',
  'react/jsx-no-script-url': 'warn',
  'react/jsx-no-target-blank': 'warn',
  'react/no-clone-element': 'warn',
  'react/no-danger-with-children': 'error',
  'react/no-did-mount-set-state': 'warn',
  'react/no-did-update-set-state': 'warn',
  'react/no-direct-mutation-state': 'error',
  'react/no-find-dom-node': 'error',
  'react/no-namespace': 'error',
  'react/no-redundant-should-component-update': 'error',
  'react/no-render-return-value': 'error',
  'react/no-string-refs': 'error',
  'react/no-unsafe': ['error', { checkAliases: true }],
  'react/no-will-update-set-state': 'warn',
  'react/void-dom-elements-no-children': 'error',
  'cherry/no-prop-types': 'error',
  'cherry/react-context-name': 'warn',
  'cherry/react-dom-no-flush-sync': 'error',
  'cherry/react-dom-no-hydrate': 'error',
  'cherry/react-dom-no-render': 'error',
  'cherry/react-dom-no-use-form-state': 'error',
  'cherry/react-no-access-state-in-setstate': 'error',
  'cherry/react-no-children-methods': 'warn',
  'cherry/react-no-context-provider': 'warn',
  'cherry/react-no-create-ref': 'error',
  'cherry/react-no-default-props': 'error',
  'cherry/react-no-forward-ref': 'warn',
  'cherry/react-no-implicit-key': 'warn',
  'cherry/react-no-leaked-interval': 'warn',
  'cherry/react-no-leaked-resize-observer': 'warn',
  'cherry/react-no-misused-capture-owner-stack': 'error',
  'cherry/react-no-nested-lazy-component-declarations': 'warn',
  'cherry/react-no-unused-class-component-members': 'warn',
  'cherry/react-no-unused-state': 'warn',
  'cherry/react-no-use-context': 'warn'
}

module.exports = defineConfig({
  categories: {},
  jsPlugins: [{ name: 'cherry', specifier: '../cherryPlugin.mjs' }],
  plugins: ['react'],
  rules: {
    ...Object.fromEntries(localRules.map((rule) => [`cherry/${rule}`, 'error'])),
    ...reactMigrationRules
  },
  overrides: [
    {
      files: ['positive/src/shared/data/cache/cacheSchemas.ts', 'negative/src/shared/data/cache/cacheSchemas.ts'],
      rules: { 'cherry/valid-schema-key': 'error' }
    },
    {
      // Locks the `react/rules-of-hooks` migration contract (matches oxlint.config.ts). Scoped to the
      // single ConditionalHook fixture so the react plugin's other defaults don't touch the rest.
      files: ['negative/src/renderer/components/ConditionalHook.tsx'],
      plugins: ['react'],
      rules: { 'react/rules-of-hooks': 'error' }
    },
    {
      files: ['negative/src/renderer/components/ReactRecommended.tsx'],
      rules: { 'cherry/dynamic-react-clone-element': 'off' }
    }
  ]
})
