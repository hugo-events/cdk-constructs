// The custom resource of TransloaditCredential (../transloadit-credential.ts): writes an IAM key into
// a Transloadit template credential through Transloadit's Node SDK. Bundled with the SDK by
// scripts/bundle-handlers.mjs into lib/transloadit-credential/handler/index.mjs.
//
// Nothing secret travels in the event: the provider framework logs every event it relays, so the
// IAM key's secret is read here from its own secret (KeySecretArn), and the Transloadit API key
// from ApiSecretId. Neither, nor the credential listing (which carries every credential's key and
// secret), nor an SDK error's `cause` (the HTTP request, body included) is ever logged or put in
// an error message.
//
// Transloadit answers a PUT by a missing name with 400 TEMPLATE_CREDENTIALS_NOT_UPDATED, the code
// of a refused update, and its listing ignores `page` and returns every credential at once
// (measured 2026-11-06), so the handler lists once, updates the credential with the name by its
// id, and creates it only when there is none. The SDK's streamTemplateCredentials would never end.

export interface CredentialClient {
  listTemplateCredentials(): Promise<{ credentials?: { id: string; name: string; deleted?: unknown }[] }>;
  editTemplateCredential(id: string, params: CredentialParams): Promise<{ ok?: string }>;
  createTemplateCredential(params: CredentialParams): Promise<{ ok?: string }>;
  deleteTemplateCredential(id: string): Promise<{ ok?: string }>;
}

interface CredentialParams {
  name: string;
  type: string;
  content: Record<string, string>;
}

export interface Deps {
  getSecret(id: string): Promise<string | undefined>;
  client(auth: { authKey: string; authSecret: string }): CredentialClient;
}

export interface Props {
  ApiSecretId: string;
  KeySecretArn: string;
  CredentialName: string;
  S3Bucket: string;
  S3BucketRegion: string;
  // "true" for a credential the stack owns outright (a developer's), deleted with the stack;
  // production's stays, as deleting it would stop every upload
  DeleteWithStack?: string;
}

interface Event {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: Props;
}

// A secret's JSON fields; the parse error is not passed on, as V8 quotes the input in it.
async function readSecret(deps: Deps, secretId: string, fields: string[]): Promise<Record<string, string>> {
  let value: Record<string, string> | undefined;
  try {
    value = JSON.parse((await deps.getSecret(secretId)) || "");
  } catch {
    throw new Error(`secret ${secretId} is not valid JSON`);
  }
  const missing = fields.filter((field) => !value || !value[field]);
  if (missing.length) {
    // fail the deploy: a credential left as it was is the outage this exists to prevent
    throw new Error(`secret ${secretId} lacks ${missing.join(", ")}`);
  }
  return value as Record<string, string>;
}

// Transloadit's own message (the SDK builds it from the response: status, code, message) for an
// ApiError; for anything else, its name only.
function refused(what: string, err: unknown): Error {
  const e = err as { name?: string; message?: string };
  return new Error(`Transloadit refused the ${what}: ${e?.name === "ApiError" ? e.message : e?.name || "unknown error"}`);
}

async function call<T>(what: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err) {
    throw refused(what, err);
  }
}

async function apiClient(deps: Deps, props: Props): Promise<CredentialClient> {
  const api = await readSecret(deps, props.ApiSecretId, ["TRANSLOADIT_AUTH_KEY", "TRANSLOADIT_AUTH_SECRET"]);
  return deps.client({ authKey: api.TRANSLOADIT_AUTH_KEY, authSecret: api.TRANSLOADIT_AUTH_SECRET });
}

// The live credentials with the name; more than one is refused, as which one a template resolves
// is Transloadit's choice.
async function named(client: CredentialClient, name: string) {
  const list = await call("listing", () => client.listTemplateCredentials());
  if (!Array.isArray(list.credentials)) throw new Error("Transloadit refused the listing: no credentials in its answer");
  const found = list.credentials.filter((c) => c.name === name && !c.deleted);
  if (found.length > 1) {
    throw new Error(`Transloadit holds ${found.length} credentials named ${name}; remove the extra ones by hand`);
  }
  return found[0];
}

export async function writeCredential(deps: Deps, props: Props): Promise<"updated" | "created"> {
  const client = await apiClient(deps, props);
  const key = await readSecret(deps, props.KeySecretArn, ["accessKeyId", "secretAccessKey"]);
  const existing = await named(client, props.CredentialName);
  const params: CredentialParams = {
    name: props.CredentialName,
    type: "s3",
    content: {
      key: key.accessKeyId,
      secret: key.secretAccessKey,
      bucket: props.S3Bucket,
      bucket_region: props.S3BucketRegion,
    },
  };
  if (existing) {
    const res = await call("update", () => client.editTemplateCredential(existing.id, params));
    if (res.ok !== "TEMPLATE_CREDENTIALS_UPDATED") throw new Error(`Transloadit refused the update: ${res.ok || "no ok"}`);
    return "updated";
  }
  const res = await call("create", () => client.createTemplateCredential(params));
  if (res.ok !== "TEMPLATE_CREDENTIALS_CREATED") throw new Error(`Transloadit refused the create: ${res.ok || "no ok"}`);
  return "created";
}

export async function onEvent(deps: Deps, event: Event): Promise<{ PhysicalResourceId: string }> {
  const props = event.ResourceProperties;
  if (event.RequestType === "Delete") {
    const physicalId = event.PhysicalResourceId || props.CredentialName;
    if (props.DeleteWithStack !== "true") {
      // left in Transloadit: deleting it would stop every upload; a renamed credential is the
      // old one's to remove by hand
      return { PhysicalResourceId: physicalId };
    }
    // a stack's removal must not hang on Transloadit: a credential that cannot be removed is
    // reported and left
    try {
      const client = await apiClient(deps, props);
      const existing = await named(client, physicalId);
      if (existing) await call("delete", () => client.deleteTemplateCredential(existing.id));
      console.log("deleted", physicalId);
    } catch (err) {
      console.log("left in Transloadit:", physicalId, (err as Error).message);
    }
    return { PhysicalResourceId: physicalId };
  }
  console.log(await writeCredential(deps, props), props.CredentialName);
  return { PhysicalResourceId: props.CredentialName };
}

export async function handler(event: Event) {
  // the Lambda runtime's AWS SDK, and Transloadit's, bundled; imported here so the tests need neither
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const { Transloadit } = await import("transloadit");
  const secrets = new SecretsManagerClient({});
  return onEvent(
    {
      getSecret: async (id) => (await secrets.send(new GetSecretValueCommand({ SecretId: id }))).SecretString,
      client: (auth) => new Transloadit(auth) as unknown as CredentialClient,
    },
    event
  );
}
