module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  // Transpile only: `tsc -p tsconfig.json` type-checks src and test (npm test, CI), and ts-jest's
  // own type-check of every file against aws-cdk-lib's types took jest past 2 GB, more than the
  // small runner's heap.
  transform: { "^.+\\.tsx?$": ["ts-jest", { isolatedModules: true }] },
};
