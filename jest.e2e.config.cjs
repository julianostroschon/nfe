module.exports = {
  preset: 'ts-jest',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.e2e-spec.ts'],
  testTimeout: 60000,
};
