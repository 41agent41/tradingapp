/**
 * Jest configuration.
 *
 * The backend uses ESM-style `.js` import suffixes in its TypeScript
 * sources (so the compiled CJS output can resolve siblings without
 * extension rewriting). Jest's resolver needs a `moduleNameMapper` to
 * strip that suffix again at test time.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2020',
          module: 'commonjs',
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  clearMocks: true,
  resetModules: true,
  testTimeout: 10000,
};
