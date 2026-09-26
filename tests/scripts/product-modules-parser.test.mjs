import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLocalValuesSource } from "../../deployment/parse-local-values.mjs";

const block = "PRODUCT_MODULES:\n  schema_version: 1\n  bots: false\n  ai: false\n  avaturn: false\n";
test("closed PRODUCT_MODULES mapping preserves strict scalar parsing", () => {
  const values = parseLocalValuesSource(`HUB_DOMAIN: example.invalid\n${block}PASSWORD: 'fixture'\n`);
  assert.deepEqual(values.get("PRODUCT_MODULES"), {schema_version:1,bots:false,ai:false,avaturn:false,avaturn_creator_url:""});
  assert.equal(values.get("PASSWORD"),"fixture");
});
for (const bad of [
  block.replace("bots: false", "bots: 'false'"), block.replace("bots: false", "bots: 0"),
  block.replace("ai: false", "ai: true"), block.replace("schema_version: 1", "schema_version: 2"),
  block + "  unknown: true\n", block + "  ai: false\n", block + "  nested:\n    value: true\n",
  block.replace("PRODUCT_MODULES:", "PRODUCT_MODULES: &alias"),
  "PRODUCT_MODULES: '{\"schema_version\":1}'\n", "OTHER:\n  bots: true\n",
  block.replace("bots: false", "bots: !!bool false"), block.replace("  bots:", "\tbots:"),
  block.replace("  bots: false\n", "")
]) test(`reject malformed product mapping ${JSON.stringify(bad)}`, () => assert.throws(() => parseLocalValuesSource(bad)));
test("Avaturn URL remains the provider production contract", () => {
  const enabled = block.replace("avaturn: false", "avaturn: true");
  assert.equal(parseLocalValuesSource(enabled + "  avaturn_creator_url: 'https://client.avaturn.dev'\n").get("PRODUCT_MODULES").avaturn_creator_url,"https://client.avaturn.dev");
  assert.throws(() => parseLocalValuesSource(enabled + "  avaturn_creator_url: 'https://demo.avaturn.dev'\n"));
  assert.throws(() => parseLocalValuesSource(enabled + '  avaturn_creator_url: "https://client.avaturn.dev\\n"\n'));
});
test("CLI exposes only canonical module JSON and refuses mapping via scalar --get",()=>{
  const parser=fileURLToPath(new URL("../../deployment/parse-local-values.mjs",import.meta.url));
  const run=(args,input)=>spawnSync(process.execPath,[parser,"/dev/stdin",...args],{input,encoding:"utf8"});
  const current=run(["--get-product-modules"],block+"PRIVATE_KEY: 'not-for-output'\n");
  assert.equal(current.status,0);assert.equal(current.stdout.includes("not-for-output"),false);
  assert.equal(JSON.parse(current.stdout).bots,false);
  assert.equal(JSON.parse(run(["--get-product-modules"],"HUB_DOMAIN: example.invalid\n").stdout).ai,false);
  const scalar=run(["--get","PRODUCT_MODULES"],block);assert.notEqual(scalar.status,0);assert.equal(scalar.stdout,"");
});
