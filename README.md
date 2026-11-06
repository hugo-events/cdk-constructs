# @hugo-events/cdk-constructs

AWS CDK constructs shared by Quriobot's and Hugo's infrastructure (`quriobot-infrastructure`,
`hugo-infrastructure`, and the `development` repository's developer stacks). Published to
GitHub Packages from a `v*` tag.

## Constructs

### `TransloaditCredential` (QB-4147)

A Transloadit template credential that holds a key CloudFormation makes: an IAM user that may only
store into the bucket, its access key (`keySerial`, bump to rotate), the key's secret in Secrets
Manager, and a custom resource that writes the key into the credential through Transloadit's
Node SDK. It lists the credentials, updates the one with the name by its id, creates it if there is
none, and refuses when two share the name. A refused write, or a missing or malformed API secret,
fails the deploy.

```ts
import { TransloaditCredential } from "@hugo-events/cdk-constructs";

new TransloaditCredential(this, "MediaCredential", {
  credentialName: "quriobot-media-production",
  bucket: mediaBucket,
  apiSecret: secretsmanager.Secret.fromSecretNameV2(this, "TransloaditApi", "quriobot/transloadit-api"),
  userName: "quriobot-media-transloadit",
});
```

`apiSecret` holds a Transloadit Auth Key with the `template_credentials:read` and `:write` scopes, as
JSON `{"TRANSLOADIT_AUTH_KEY": "…", "TRANSLOADIT_AUTH_SECRET": "…"}`, filled by hand.
`deleteWithStack: true` removes the credential from Transloadit with the stack (a developer's);
by default it stays, as templates in use rely on it. A stack's credentials share one provider
(`TransloaditCredentialProvider.of(stack)`), whose `handler` takes grants a credential cannot make
itself, such as a cross-account secret's KMS key.

The handler is bundled with its dependencies when the package is built
(`lib/transloadit-credential/handler/index.mjs`), so a consumer needs neither esbuild nor the SDK.

## Installing

GitHub Packages needs a token even to install. Map the scope in the consumer's committed `.npmrc`:

```
@hugo-events:registry=https://npm.pkg.github.com
```

and give npm a token with `read:packages` outside the repository:

- **A developer:** once, `gh auth refresh -s read:packages`, then
  `npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"` (writes `~/.npmrc`).
- **CI:** the job's `GITHUB_TOKEN` with `packages: read`, written to `~/.npmrc` before `npm ci`.
  The consumer repository needs read access on the package (package settings → Manage Actions
  access).

## Releasing

Bump `version` in `package.json`, merge, then tag that commit `v<version>` and push the tag. The
Publish workflow checks the tag against `package.json`, tests, and publishes.

## Developing

`npm test` builds, bundles the handlers, type-checks and runs jest, including a test that runs the
bundle in Node.
