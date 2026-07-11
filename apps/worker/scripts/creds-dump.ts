import { getDb } from "@ytauto/db";
import { loadSecretsEnv } from "@ytauto/core";
const env = await loadSecretsEnv(getDb());
process.stdout.write(JSON.stringify({ id: env.REMOTION_AWS_ACCESS_KEY_ID ?? "", secret: env.REMOTION_AWS_SECRET_ACCESS_KEY ?? "" }));
