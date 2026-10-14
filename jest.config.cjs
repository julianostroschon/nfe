module.exports = {
  preset: 'ts-jest',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.spec.ts'],
  testTimeout: 30000,
};
