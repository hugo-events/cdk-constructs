import * as childProcess from "child_process";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Match, Template } from "aws-cdk-lib/assertions";
// The built package, as a consumer gets it: the construct deploys the bundle in lib/.
import { TransloaditCredential, TransloaditCredentialProvider } from "../lib";
import { CredentialClient, onEvent } from "../src/transloadit-credential/handler";

// QB-4147: Transloadit stores uploads with a key CloudFormation makes and writes into the
// credential the templates name, so a key rotation can never leave Transloadit holding a dead key.
function stackWith(credentials: { name: string; deleteWithStack?: boolean; userName?: string }[]) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Stack", { env: { account: "111111111111", region: "eu-west-1" } });
  const apiSecret = secretsmanager.Secret.fromSecretNameV2(stack, "Api", "quriobot/transloadit-api");
  for (const c of credentials) {
    new TransloaditCredential(stack, c.name, {
      credentialName: c.name,
      bucket: s3.Bucket.fromBucketName(stack, `${c.name}Bucket`, `${c.name}-bucket`),
      apiSecret,
      userName: c.userName,
      deleteWithStack: c.deleteWithStack,
    });
  }
  return { stack, template: Template.fromStack(stack) };
}

describe("TransloaditCredential", () => {
  const { template } = stackWith([{ name: "media-production", userName: "media-transloadit" }]);

  test("hands the handler names and the key's id, never the key's secret", () => {
    const [resource] = Object.values(template.findResources("Custom::TransloaditCredential")) as any[];
    expect(resource.Properties).toEqual({
      ServiceToken: expect.anything(),
      HandlerHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      // the secret's ARN, so a cross-account secret is found too
      ApiSecretId: expect.anything(),
      KeySecretArn: { Ref: expect.stringMatching(/AccessKeySecret/) },
      AccessKeyId: { Ref: expect.stringMatching(/AccessKey[0-9A-F]{8}$/) },
      CredentialName: "media-production",
      S3Bucket: "media-production-bucket",
      S3BucketRegion: "eu-west-1",
      DeleteWithStack: "false",
    });
    expect(JSON.stringify(resource.Properties.ApiSecretId)).toContain(":secret:quriobot/transloadit-api");
    expect(JSON.stringify(resource.Properties)).not.toContain("SecretAccessKey");
  });

  test("keeps the key's secret in a secret", () => {
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      SecretString: {
        "Fn::Join": ["", Match.arrayWith([Match.objectLike({ "Fn::GetAtt": [Match.stringLikeRegexp("AccessKey"), "SecretAccessKey"] })])],
      },
    });
    template.hasResourceProperties("AWS::IAM::AccessKey", { Serial: 1 });
  });

  test("lets the key store objects in the bucket and nothing else", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: ["s3:PutObject", "s3:PutObjectAcl", "s3:AbortMultipartUpload"],
            Effect: "Allow",
            Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":s3:::media-production-bucket/*"]] },
          },
          {
            Action: "s3:GetBucketLocation",
            Effect: "Allow",
            Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":s3:::media-production-bucket"]] },
          },
        ],
      },
      Users: [{ Ref: Match.stringLikeRegexp("User") }],
    });
    template.hasResourceProperties("AWS::IAM::User", { UserName: "media-transloadit" });
  });

  test("runs the bundled handler on Node 22, arm64, with bounded logs", () => {
    template.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs22.x", Architectures: ["arm64"], Handler: "index.handler" });
    const groups = Object.values(template.findResources("AWS::Logs::LogGroup")) as any[];
    expect(groups.map((g) => g.Properties.RetentionInDays)).toEqual([90, 90]);
  });

  test("shares one provider among a stack's credentials, and marks one the stack owns", () => {
    const { stack, template: two } = stackWith([{ name: "hugo-dev" }, { name: "qb-dev", deleteWithStack: true }]);
    expect(TransloaditCredentialProvider.of(stack)).toBe(TransloaditCredentialProvider.of(stack));
    const handlers = Object.values(two.findResources("AWS::Lambda::Function")) as any[];
    // the handler and the provider framework's function, once
    expect(handlers).toHaveLength(2);
    const resources = Object.values(two.findResources("Custom::TransloaditCredential")) as any[];
    expect(resources.map((r) => [r.Properties.CredentialName, r.Properties.DeleteWithStack])).toEqual([
      ["hugo-dev", "false"],
      ["qb-dev", "true"],
    ]);
  });
});

// The bundle the construct deploys, run in Node: the SDK is ESM-only, and a bundle that cannot
// load it fails only once deployed.
test("the handler's bundle loads Transloadit's SDK and answers a Delete without calling it", () => {
  const bundle = path.join(__dirname, "..", "lib", "transloadit-credential", "handler", "index.mjs");
  const event = JSON.stringify({ RequestType: "Delete", PhysicalResourceId: "kept", ResourceProperties: { CredentialName: "kept" } });
  const result = childProcess.execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(bundle)}); console.log(JSON.stringify(await m.handler(${event})));`],
    { cwd: path.join(__dirname, ".."), stdio: "pipe" }
  );
  expect(JSON.parse(result.toString().trim())).toEqual({ PhysicalResourceId: "kept" });
});

const API_SECRET = "transloadit-api-secret-value";
const S3_SECRET = "iam-secret-access-key-value";
const props = {
  ApiSecretId: "quriobot/transloadit-api",
  KeySecretArn: "arn:key-secret",
  AccessKeyId: "AKIAEXAMPLE",
  CredentialName: "quriobot-media-production",
  S3Bucket: "quriobot-media-prod",
  S3BucketRegion: "eu-west-1",
};
const secrets: Record<string, string | undefined> = {
  "quriobot/transloadit-api": JSON.stringify({ TRANSLOADIT_AUTH_KEY: "auth-key", TRANSLOADIT_AUTH_SECRET: API_SECRET }),
  "arn:key-secret": JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: S3_SECRET }),
};

type Call = { op: string; args: unknown[] };
type Answer = Record<string, unknown> | Error;

// A fake SDK client: answers each operation from `answers` in order and records the calls.
function fakeTransloadit(answers: Partial<Record<keyof CredentialClient, Answer[]>>, secretValues = secrets) {
  const calls: Call[] = [];
  const auths: unknown[] = [];
  const op = (name: keyof CredentialClient) => async (...args: unknown[]) => {
    calls.push({ op: name, args });
    const next = (answers[name] || []).shift();
    if (next instanceof Error) throw next;
    return next ?? {};
  };
  const client: CredentialClient = {
    listTemplateCredentials: op("listTemplateCredentials") as CredentialClient["listTemplateCredentials"],
    editTemplateCredential: op("editTemplateCredential") as CredentialClient["editTemplateCredential"],
    createTemplateCredential: op("createTemplateCredential") as CredentialClient["createTemplateCredential"],
    deleteTemplateCredential: op("deleteTemplateCredential") as CredentialClient["deleteTemplateCredential"],
  };
  const deps = {
    getSecret: async (id: string) => secretValues[id],
    client: (auth: unknown) => {
      auths.push(auth);
      return client;
    },
  };
  return { deps, calls, auths, ops: () => calls.map((c) => c.op) };
}

// An SDK ApiError: its message is Transloadit's answer, and its cause the HTTP request, secret
// included, which must never be passed on.
function apiError(message: string) {
  return Object.assign(new Error(message), { name: "ApiError", cause: { options: { body: S3_SECRET } } });
}

const listing = (...credentials: unknown[]) => ({ ok: "TEMPLATE_CREDENTIALS_FOUND", credentials });
const create = { RequestType: "Create" as const, ResourceProperties: props };

describe("the Transloadit credential handler", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    jest.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    // nothing secret is ever printed
    expect(logs.join("\n")).not.toMatch(new RegExp(`${API_SECRET}|${S3_SECRET}`));
  });

  test("updates the credential with the name, by its id, with the key from the key's secret", async () => {
    const t = fakeTransloadit({
      listTemplateCredentials: [listing({ id: "other", name: "quriobot-media-dev", deleted: null }, { id: "abc123", name: props.CredentialName, deleted: null })],
      editTemplateCredential: [{ ok: "TEMPLATE_CREDENTIALS_UPDATED" }],
    });
    expect(await onEvent(t.deps, create)).toEqual({ PhysicalResourceId: props.CredentialName });
    expect(t.auths).toEqual([{ authKey: "auth-key", authSecret: API_SECRET }]);
    expect(t.ops()).toEqual(["listTemplateCredentials", "editTemplateCredential"]);
    expect(t.calls[1].args).toEqual([
      "abc123",
      {
        name: props.CredentialName,
        type: "s3",
        content: { key: "AKIAEXAMPLE", secret: S3_SECRET, bucket: "quriobot-media-prod", bucket_region: "eu-west-1" },
      },
    ]);
    expect(logs).toEqual(["updated quriobot-media-production"]);
  });

  test("creates the credential when none has the name, a deleted one included", async () => {
    const t = fakeTransloadit({
      listTemplateCredentials: [listing({ id: "gone", name: props.CredentialName, deleted: "2026-10-01 00:00:00" })],
      createTemplateCredential: [{ ok: "TEMPLATE_CREDENTIALS_CREATED" }],
    });
    await onEvent(t.deps, { ...create, RequestType: "Update" });
    expect(t.ops()).toEqual(["listTemplateCredentials", "createTemplateCredential"]);
    expect((t.calls[1].args[0] as { name: string }).name).toBe(props.CredentialName);
    expect(logs).toEqual(["created quriobot-media-production"]);
  });

  test("fails, without writing, when two credentials have the name", async () => {
    const t = fakeTransloadit({ listTemplateCredentials: [listing({ id: "a", name: props.CredentialName }, { id: "b", name: props.CredentialName })] });
    await expect(onEvent(t.deps, create)).rejects.toThrow("Transloadit holds 2 credentials named quriobot-media-production");
    expect(t.ops()).toEqual(["listTemplateCredentials"]);
  });

  test.each([
    ["listing", { listTemplateCredentials: [apiError("API error (HTTP 403) GET_ACCOUNT_UNKNOWN_AUTH_KEY: unknown key")] }],
    ["update", { listTemplateCredentials: [listing({ id: "abc123", name: props.CredentialName })], editTemplateCredential: [apiError("API error (HTTP 400) TEMPLATE_CREDENTIALS_NOT_UPDATED: no")] }],
    ["create", { listTemplateCredentials: [listing()], createTemplateCredential: [apiError("API error (HTTP 400) TEMPLATE_CREDENTIALS_NOT_SAVED: no")] }],
    ["update", { listTemplateCredentials: [listing({ id: "abc123", name: props.CredentialName })], editTemplateCredential: [{ ok: "SOMETHING_ELSE" }] }],
    ["create", { listTemplateCredentials: [listing()], createTemplateCredential: [{}] }],
  ] as [string, Partial<Record<keyof CredentialClient, Answer[]>>][])("fails the deploy when Transloadit refuses the %s", async (what, answers) => {
    const t = fakeTransloadit(answers);
    const error = (await onEvent(t.deps, create).catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(new RegExp(`^Transloadit refused the ${what}: `));
    expect(error.message).not.toMatch(new RegExp(`${API_SECRET}|${S3_SECRET}`));
  });

  test("passes on no more of a non-API error than its name", async () => {
    const t = fakeTransloadit({ listTemplateCredentials: [Object.assign(new Error(`request to https://x?secret=${S3_SECRET}`), { name: "RequestError" })] });
    const error = (await onEvent(t.deps, create).catch((e: Error) => e)) as Error;
    expect(error.message).toBe("Transloadit refused the listing: RequestError");
  });

  test.each([
    ["is missing", undefined, "secret quriobot/transloadit-api is not valid JSON"],
    ["is not JSON", `{"TRANSLOADIT_AUTH_SECRET": "${API_SECRET}"`, "secret quriobot/transloadit-api is not valid JSON"],
    ["lacks the secret", JSON.stringify({ TRANSLOADIT_AUTH_KEY: "k" }), "secret quriobot/transloadit-api lacks TRANSLOADIT_AUTH_SECRET"],
  ])("fails the deploy, calling nothing, when the API secret %s", async (_, value, message) => {
    const t = fakeTransloadit({}, { ...secrets, "quriobot/transloadit-api": value });
    const error = (await onEvent(t.deps, create).catch((e: Error) => e)) as Error;
    expect(error.message).toBe(message);
    expect(t.calls).toHaveLength(0);
  });

  test("fails, calling nothing, when the key's secret lacks the secret access key", async () => {
    const t = fakeTransloadit({}, { ...secrets, "arn:key-secret": JSON.stringify({ accessKeyId: "AKIAEXAMPLE" }) });
    await expect(onEvent(t.deps, create)).rejects.toThrow("secret arn:key-secret lacks secretAccessKey");
    expect(t.calls).toHaveLength(0);
  });

  test("leaves production's credential in Transloadit on Delete", async () => {
    const t = fakeTransloadit({});
    expect(await onEvent(t.deps, { RequestType: "Delete", PhysicalResourceId: "old-name", ResourceProperties: props })).toEqual({
      PhysicalResourceId: "old-name",
    });
    expect(t.calls).toHaveLength(0);
  });

  test("deletes a credential the stack owns on Delete, and never fails the removal", async () => {
    const owned = { ...props, DeleteWithStack: "true" };
    const t = fakeTransloadit({
      listTemplateCredentials: [listing({ id: "abc123", name: "dev-media" })],
      deleteTemplateCredential: [{ ok: "TEMPLATE_CREDENTIALS_DELETED" }],
    });
    await onEvent(t.deps, { RequestType: "Delete", PhysicalResourceId: "dev-media", ResourceProperties: owned });
    expect(t.calls.map((c) => [c.op, ...c.args])).toEqual([["listTemplateCredentials"], ["deleteTemplateCredential", "abc123"]]);

    const failing = fakeTransloadit({ listTemplateCredentials: [apiError("API error (HTTP 500) INTERNAL: down")] });
    expect(await onEvent(failing.deps, { RequestType: "Delete", PhysicalResourceId: "dev-media", ResourceProperties: owned })).toEqual({
      PhysicalResourceId: "dev-media",
    });
    expect(logs.at(-1)).toMatch(/^left in Transloadit: dev-media Transloadit refused the listing: /);
  });
});
