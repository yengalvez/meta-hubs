// Pure actual backend broadcast clause -> actual Phoenix -> mounted chat hook.
// No Reticulum application, native browser, HTTP, DB, provider or deployment.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const events = ["product_modules_changed", "avaturn_capabilities_changed"];

function forwardedEvents(output) {
  assert.equal(typeof output, "string");
  assert.ok(Buffer.byteLength(output) <= 1024);
  const lines = output.trim().split("\n");
  assert.equal(lines.length, events.length);
  const mapping = new Map();
  for (const line of lines) {
    const fields = line.split("=");
    assert.equal(fields.length, 2);
    const [origin, wire] = fields;
    assert.ok(events.includes(origin));
    assert.equal(wire, origin, "backend must not alias creator events to chat-invalidating events");
    assert.equal(mapping.has(origin), false);
    mapping.set(origin, wire);
  }
  assert.equal(mapping.size, events.length);
  return Object.fromEntries(mapping);
}

test("the test-only wire mapping rejects malformed, duplicate and contradictory backend output", () => {
  for (const output of [
    null, "", "unknown=unknown\navaturn_capabilities_changed=avaturn_capabilities_changed\n",
    "product_modules_changed=product_modules_changed\nproduct_modules_changed=product_modules_changed\n",
    "product_modules_changed=product_modules_changed\navaturn_capabilities_changed=product_modules_changed\n",
    "product_modules_changed=avaturn_capabilities_changed\navaturn_capabilities_changed=avaturn_capabilities_changed\n",
    "product_modules_changed=product_modules_changed\navaturn_capabilities_changed=avaturn_capabilities_changed\nextra=extra\n",
    "product_modules_changed=product_modules_changed=extra\navaturn_capabilities_changed=avaturn_capabilities_changed\n"
  ]) assert.throws(() => forwardedEvents(output));
});

test("compiled backend event provenance preserves creator-only requests and keeps revocation controls", () => {
  const source = fs.readFileSync(new URL(
    "../../hubs-cloud/community-edition/services/reticulum/lib/ret_web/channels/hub_channel.ex", import.meta.url
  ), "utf8");
  const start = source.indexOf('  def handle_info(\n        %Phoenix.Socket.Broadcast{\n          topic: "ret:product_modules",');
  const end = source.indexOf("  def handle_info(_message, socket)", start);
  assert.ok(start >= 0 && end > start, "exact backend broadcast clause is required");
  const script = `
defmodule Phoenix.Socket.Broadcast do
  defstruct [:topic, :event, :payload]
end
defmodule SourceModuleBridge do
${source.slice(start, end)}
  defp push(socket, event, payload), do: send(socket.receiver, {:module_push, event, payload})
end
socket = %{receiver: self(), chat_namespace: :unchanged, chat_revision: 7}
payload = %{bots_enabled: true, ai_enabled: true, avaturn_enabled: false}
for origin <- ["product_modules_changed", "avaturn_capabilities_changed"] do
  message = struct(Phoenix.Socket.Broadcast, topic: "ret:product_modules", event: origin, payload: payload)
  {:noreply, ^socket} = SourceModuleBridge.handle_info(message, socket)
  receive do
    {:module_push, event, ^payload} -> IO.puts(origin <> "=" <> event)
  after 0 -> raise("missing module push")
  end
end
`;
  const result = spawnSync("elixir", ["-e", script], {
    encoding: "utf8", timeout: 10000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, LANG: "C", ERL_FLAGS: "+S 2:2" }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, "actual pure backend clause must complete");
  // This mapping comes only from the compiled source above. Aliasing/malformed
  // source cannot fall back to the Hubs standalone identity mapping.
  const mapping = forwardedEvents(result.stdout);
  const hubs = fileURLToPath(new URL("../../hubs/", import.meta.url));
  const mounted = spawnSync(process.execPath, [
    fileURLToPath(new URL("../../hubs/node_modules/ava/entrypoints/cli.mjs", import.meta.url)),
    "--serial", "--timeout=30s", "test/unit/react-components/use-bot-chat-request.test.js"
  ], {
    cwd: hubs, encoding: "utf8", timeout: 30000, maxBuffer: 262144,
    env: { PATH: process.env.PATH, LANG: "C", BABEL_DISABLE_CACHE: "1",
      YENHUBS_TEST_MODULE_EVENT_MAP: JSON.stringify(mapping) }
  });
  assert.equal(mounted.error, undefined);
  assert.equal(mounted.signal, null);
  assert.equal(mounted.status, 0, `actual mapped Phoenix/mounted hook controls failed:\n${mounted.stdout}\n${mounted.stderr}`);
  assert.match(mounted.stdout, /14 tests passed/);
});
