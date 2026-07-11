import { getDb } from "@ytauto/db";
import { loadSecretsEnv } from "@ytauto/core";
const db = getDb();
const env = await loadSecretsEnv(db);
const id = env.REMOTION_AWS_ACCESS_KEY_ID, secret = env.REMOTION_AWS_SECRET_ACCESS_KEY;
if (!id || !secret) { console.log("creds not decryptable"); process.exit(1); }
const { ServiceQuotasClient, GetServiceQuotaCommand } = await import("@aws-sdk/client-service-quotas");
const sq = new ServiceQuotasClient({ region: "ap-southeast-2", credentials: { accessKeyId: id, secretAccessKey: secret } });
const q = await sq.send(new GetServiceQuotaCommand({ ServiceCode: "lambda", QuotaCode: "L-B99A9384" }));
console.log("Lambda concurrent-executions quota now:", q.Quota?.Value);
