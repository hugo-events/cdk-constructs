// Bundles each custom resource's handler, with its dependencies, into lib/<construct>/handler/index.mjs,
// so a consumer deploys it with Code.fromAsset and needs neither esbuild nor the dependencies.
// ESM, as Transloadit's SDK is ESM-only, with a `require` for the CommonJS modules it pulls in;
// @aws-sdk/* is the Lambda runtime's and stays out.
import { build } from "esbuild";

export const handlers = ["transloadit-credential"];

export const options = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  mainFields: ["module", "main"],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  external: ["@aws-sdk/*"],
  legalComments: "none",
};

for (const name of handlers) {
  await build({ ...options, entryPoints: [`src/${name}/handler.ts`], outfile: `lib/${name}/handler/index.mjs` });
}
