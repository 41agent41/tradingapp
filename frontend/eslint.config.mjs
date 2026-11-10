// ESLint flat config (ESLint 9, Next.js 16). Replaces .eslintrc.json:
// `next lint` was removed in Next.js 16, so `npm run lint` runs eslint itself.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier/flat';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'out/**', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
  prettier,
  {
    rules: {
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      // New in eslint-plugin-react-hooks 6 (React Compiler checks). The
      // existing pages load data in effects throughout; they are reported as
      // warnings until those pages are reworked, not hidden.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
];

export default config;
