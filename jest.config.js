module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  transform: { "^.+\\.tsx?$": "ts-jest" },
  // ts before js, so a test never runs against a stale build of the source next to it
  moduleFileExtensions: ["ts", "js", "json", "node"],
  reporters: ["default", ["jest-junit", { outputDirectory: "<rootDir>", outputName: "junit.xml" }]],
};
