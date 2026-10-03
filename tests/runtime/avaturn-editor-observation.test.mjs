// Pure contracts/source wiring only. No React/native/SDK/browser acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AVATURN_OBSERVATION_CEILING_MS, AVATURN_OBSERVATION_INTERVAL_MS, createAvaturnEditorObservation,
} from "./avaturn-editor-observation.mjs";

const context = (patch = {}) => ({ creatorEnabled: true, socketConnected: true, callbackcount: 0, ...patch });
const editor = (patch = {}) => ({
  props: { mode: "avaturn" }, unmounted: false, glbSelectionId: 1,
  uploadInFlight: false, avaturnSaveController: null, ...patch,
});
const begin = () => {
  const instance = editor(), controller = new AbortController(), observer = createAvaturnEditorObservation();
  observer.attachEditor(instance);
  observer.sample(context());
  instance.uploadInFlight = true;
  instance.avaturnSaveController = controller;
  const facts = observer.sample(context());
  assert.equal(facts.upload_started, true);
  assert.equal(facts.controller_seen_count, 1);
  assert.equal(facts.same_editor_instance, true);
  assert.equal(facts.upload_drained, false);
  return { instance, controller, observer };
};
const off = (instance, controller) => {
  // Actual AbortController, not a synthesized callback/event or fake signal.
  controller.abort();
  instance.glbSelectionId += 1;
};
const finallyFields = instance => {
  instance.avaturnSaveController = null;
  instance.uploadInFlight = false;
};

test("initial, receiving and OFF invalidation are never an upload/finally observation", () => {
  const observer = createAvaturnEditorObservation();
  assert.equal(observer.snapshot().observation_state, "WAITING_EDITOR");
  for (const patch of [
    {}, { uploadInFlight: undefined, avaturnSaveController: undefined },
    { state: { uploading: false, avaturnSaveState: "receiving", previewReady: false } },
  ]) {
    const observer = createAvaturnEditorObservation(), instance = editor(patch);
    observer.attachEditor(instance);
    for (const value of [context(), context({ creatorEnabled: false })]) {
      const facts = observer.sample(value);
      assert.equal(facts.controller_seen_count, 0);
      assert.equal(facts.upload_started, false);
      assert.equal(facts.upload_drained, false);
      assert.equal(facts.abort_event_seen, false);
      assert.equal(facts.same_editor_instance, true);
    }
  }
  const { instance, controller, observer: active } = begin();
  off(instance, controller);
  instance.state = { uploading: false, avaturnSaveState: null, avaturnSaveAttempted: false, previewReady: false };
  const invalidated = active.sample(context({ creatorEnabled: false }));
  assert.equal(invalidated.abort_event_seen, true);
  assert.equal(invalidated.aborted_signal, true);
  assert.equal(invalidated.off_observed, true);
  assert.equal(invalidated.is_current_guards, false);
  assert.equal(invalidated.upload_in_flight, true);
  assert.equal(invalidated.original_controller_present, true);
  assert.equal(invalidated.upload_drained, false);
  active.stop();
});

test("one original live controller + genuine abort event + OFF + both finally fields records drainage", () => {
  const { instance, controller, observer } = begin();
  off(instance, controller);
  const aborted = observer.sample(context({ creatorEnabled: false }));
  assert.equal(aborted.observation_state, "ABORTED_SIGNAL");
  assert.equal(aborted.upload_drained, false);
  // Neither field alone is finally completion, and undefined is not null.
  instance.uploadInFlight = false;
  assert.equal(observer.sample(context({ creatorEnabled: false })).upload_drained, false);
  instance.avaturnSaveController = undefined;
  assert.equal(observer.sample(context({ creatorEnabled: false })).upload_drained, false);
  instance.avaturnSaveController = null;
  instance.uploadInFlight = true;
  assert.equal(observer.sample(context({ creatorEnabled: false })).upload_drained, false);
  instance.uploadInFlight = false;
  const drained = observer.sample(context({ creatorEnabled: false }));
  assert.equal(drained.observation_state, "UPLOAD_DRAINED");
  assert.equal(drained.upload_drained, true);
  assert.equal(drained.same_editor_instance, true);
  assert.equal(drained.abort_event_seen, true);
  assert.equal(drained.aborted_signal, true);
  assert.equal(drained.controller_seen_count, 1);
  assert.equal(drained.editor_mount_count, 1);
  assert.deepEqual(drained.invalid_reasons, []);
  assert.equal(drained.callbackcount, 0);
  observer.stop();
});

test("drainage without the original signal event/OFF is incomplete, never inferred from a normal completion", () => {
  const first = begin();
  finallyFields(first.instance);
  const completed = first.observer.sample(context({ creatorEnabled: false }));
  assert.equal(completed.upload_drained, false);
  assert.equal(completed.aborted_signal, false);
  assert.equal(completed.abort_event_seen, false);
  first.observer.stop();

  const second = begin();
  second.controller.abort();
  finallyFields(second.instance);
  const noOff = second.observer.sample(context());
  assert.equal(noOff.abort_event_seen, true);
  assert.equal(noOff.off_observed, false);
  assert.equal(noOff.upload_drained, false);
  second.observer.stop();
});

test("already aborted, post-revocation, non-inflight or non-Avaturn first sighting cannot become drainage", () => {
  for (const mode of ["preaborted", "off", "socket_closed", "not_inflight", "private_glb"]) {
    const controller = new AbortController();
    if (mode === "preaborted") controller.abort();
    const instance = editor({ uploadInFlight: mode !== "not_inflight", avaturnSaveController: controller,
      props: { mode: mode === "private_glb" ? "private-glb" : "avaturn" } });
    const observer = createAvaturnEditorObservation();
    observer.attachEditor(instance);
    const first = observer.sample(context({ creatorEnabled: mode !== "off", socketConnected: mode !== "socket_closed" }));
    assert.equal(first.observation_state, "INVALID", mode);
    assert.equal(first.upload_started, false, mode);
    if (mode === "preaborted") {
      assert.equal(first.aborted_signal, true);
      assert.equal(first.abort_event_seen, false);
    } else controller.abort();
    finallyFields(instance);
    assert.equal(observer.sample(context({ creatorEnabled: false })).upload_drained, false, mode);
    observer.stop();
  }
  const observer = createAvaturnEditorObservation();
  observer.attachEditor(editor({ uploadInFlight: true, avaturnSaveController: { signal: { aborted: false } } }));
  const result = observer.sample(context());
  assert.equal(result.upload_drained, false);
  assert.deepEqual(result.invalid_reasons, ["controller_signal_unavailable"]);
});

test("only the original genuine signal can record an abort; arbitrary dispatch fails closed", () => {
  const { instance, controller, observer } = begin();
  const unrelated = new AbortController();
  unrelated.abort();
  assert.equal(observer.sample(context()).abort_event_seen, false);
  controller.signal.dispatchEvent(new Event("abort"));
  const fabricated = observer.sample(context());
  assert.equal(fabricated.abort_event_seen, false);
  assert.equal(fabricated.aborted_signal, false);
  assert.ok(fabricated.invalid_reasons.includes("abort_event_without_aborted_original_signal"));
  off(instance, controller);
  finallyFields(instance);
  assert.equal(observer.sample(context({ creatorEnabled: false })).upload_drained, false);
  observer.stop();
});

test("repeated controller identities keep the count and invalidate instead of resetting the observed upload", () => {
  const { instance, controller, observer } = begin();
  const replacement = new AbortController();
  instance.avaturnSaveController = replacement;
  const replaced = observer.sample(context());
  assert.equal(replaced.controller_seen_count, 2);
  assert.equal(replaced.original_controller_present, false);
  assert.ok(replaced.invalid_reasons.includes("multiple_controllers"));
  replacement.abort();
  assert.equal(observer.sample(context({ creatorEnabled: false })).abort_event_seen, false);
  controller.abort();
  finallyFields(instance);
  const after = observer.sample(context({ creatorEnabled: false, callbackcount: 2 }));
  assert.equal(after.controller_seen_count, 2);
  assert.equal(after.callbackcount, 2);
  assert.equal(after.upload_drained, false);
  observer.stop();

  const repeat = begin();
  off(repeat.instance, repeat.controller);
  finallyFields(repeat.instance);
  assert.equal(repeat.observer.sample(context({ creatorEnabled: false })).upload_drained, true);
  repeat.instance.avaturnSaveController = repeat.controller;
  repeat.instance.uploadInFlight = true;
  const reappeared = repeat.observer.sample(context({ creatorEnabled: false }));
  assert.equal(reappeared.controller_seen_count, 1);
  assert.ok(reappeared.invalid_reasons.includes("original_controller_reappeared"));
  finallyFields(repeat.instance);
  assert.equal(repeat.observer.sample(context({ creatorEnabled: false })).upload_drained, false);
  repeat.observer.stop();
});

test("unmount/replacement/remount invalidates the same-instance proof and cleans the original signal listener", () => {
  const { instance, controller, observer } = begin();
  observer.attachEditor(null);
  controller.abort();
  finallyFields(instance);
  const detached = observer.sample(context({ creatorEnabled: false, callbackcount: 1 }));
  assert.equal(detached.abort_event_seen, false, "removed listener must not record a later abort");
  assert.equal(detached.same_editor_instance, false);
  assert.equal(detached.upload_drained, false);
  assert.equal(detached.callbackcount, 1);
  observer.attachEditor(instance);
  const remounted = observer.sample(context({ creatorEnabled: false, callbackcount: 1 }));
  assert.equal(remounted.editor_mount_count, 2);
  assert.ok(remounted.invalid_reasons.includes("editor_remounted"));
  assert.equal(remounted.same_editor_instance, false);
  observer.attachEditor(editor());
  const replaced = observer.sample(context({ callbackcount: 2 }));
  assert.equal(replaced.editor_mount_count, 3);
  assert.ok(replaced.invalid_reasons.includes("editor_replaced"));
  assert.equal(replaced.controller_seen_count, 1);
  observer.stop();

  const flagged = begin();
  flagged.instance.unmounted = true;
  off(flagged.instance, flagged.controller);
  finallyFields(flagged.instance);
  const unmounted = flagged.observer.sample(context({ creatorEnabled: false }));
  assert.equal(unmounted.same_editor_instance, false);
  assert.equal(unmounted.upload_drained, false);
  assert.ok(unmounted.invalid_reasons.includes("editor_unmounted"));
  flagged.observer.stop();
});

test("cleanup/deadline is idempotent, removes listeners and cannot retain a live/drained claim", () => {
  for (const reason of ["harness_teardown", "deadline"]) {
    const { instance, controller, observer } = begin();
    const stopped = observer.stop(reason);
    assert.equal(stopped.observation_state, "STOPPED");
    assert.equal(stopped.same_editor_instance, false);
    assert.equal(stopped.upload_drained, false);
    controller.abort();
    finallyFields(instance);
    observer.attachEditor(instance);
    const after = observer.sample(context({ creatorEnabled: false, callbackcount: 3 }));
    assert.equal(after.abort_event_seen, false);
    assert.equal(after.upload_drained, false);
    assert.equal(after.callbackcount, 3);
    assert.equal(after.editor_mount_count, 1);
    assert.deepEqual(observer.stop(reason), after);
  }
});

test("saved state on the original instance stays visible and invalidates canceled drainage without exposing the avatar", () => {
  for (const patch of [{ savedAvaturn: { avatar_id: "SECRET_SID", base_gltf_url: "SECRET_URL" } },
    { state: { avaturnSaveState: "saved" } }]) {
    const { instance, controller, observer } = begin();
    off(instance, controller);
    finallyFields(instance);
    Object.assign(instance, patch);
    const late = observer.sample(context({ creatorEnabled: false }));
    assert.equal(late.saved_state_seen, true);
    assert.equal(late.upload_drained, false);
    assert.ok(late.invalid_reasons.includes("save_state_seen_during_cancel_observation"));
    assert.doesNotMatch(JSON.stringify(late), /SECRET_/);
    delete instance.savedAvaturn;
    instance.state = { avaturnSaveState: null };
    assert.equal(observer.sample(context({ creatorEnabled: false })).saved_state_seen, true);
    observer.stop();
  }
});

test("sampling is read-only and its closed projection never exposes private editor/account/asset fields", () => {
  const controller = new AbortController();
  const instance = Object.freeze(editor({
    uploadInFlight: true, avaturnSaveController: controller,
    props: Object.freeze({ mode: "avaturn", avatarId: "SECRET_SID", onSave: () => { throw new Error("not called"); } }),
    state: Object.freeze({ avatar: Object.freeze({ account_id: "SECRET_OWNER", email: "SECRET_EMAIL", files: { glb: "SECRET_URL" } }) }),
    uploadAvatar: () => { throw new Error("not called"); },
    isAvaturnEnabled: () => { throw new Error("not called"); },
  }));
  const observer = createAvaturnEditorObservation();
  observer.attachEditor(instance);
  const before = Object.getOwnPropertyDescriptors(instance);
  observer.sample(context({ callbackcount: 1 }));
  const projection = observer.sample(context({ callbackcount: 4 }));
  assert.deepEqual(Object.getOwnPropertyDescriptors(instance), before);
  assert.equal(projection.callbackcount, 4);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.invalid_reasons), true);
  assert.doesNotMatch(JSON.stringify(projection), /SECRET_|"(?:avatarId|account_id|email|files|signal|controller)":/);
  assert.equal(Object.hasOwn(projection, "browser_fetch_terminal"), false);
  assert.equal(Object.hasOwn(projection, "PASS"), false);
  assert.equal(Object.hasOwn(projection, "acceptance"), false);
  const regressed = observer.sample(context({ callbackcount: 2 }));
  assert.equal(regressed.callbackcount, 2, "the supplied real count is not replaced/hidden");
  assert.ok(regressed.invalid_reasons.includes("callbackcount_regressed"));
  observer.stop();
});

test("source wiring retains real react-intl/class ref, all callbacks, untouched reload/network, and one bounded poll", () => {
  const read = relative => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const entry = read("./profile-avaturn-editor-entry.js"), module = read("./avaturn-editor-observation.mjs");
  const product = read("../../hubs/src/react-components/avatar-editor.js");
  // This CI lane deliberately has no installed Hubs dependencies. Pin its
  // tracked contract here; the native browser must prove the actual class ref.
  const declaredIntl = JSON.parse(read("../../hubs/package.json")).dependencies["react-intl"];
  const lockedIntl = JSON.parse(read("../../hubs/package-lock.json")).packages["node_modules/react-intl"].version;
  assert.match(product, /export default injectIntl\(AvatarEditor\)/);
  assert.equal(declaredIntl, "^6.4.2");
  assert.equal(lockedIntl, "6.4.2");
  assert.match(entry, /const AvatarEditor = initialSid === null\s*\? injectIntl\(DefaultAvatarEditor.WrappedComponent, \{ forwardRef: true \}\) : DefaultAvatarEditor/);
  assert.match(entry, /editor === "new" \? \{ ref: observeEditor \} : \{\}/);
  assert.match(entry, /observer.attachEditor\(instance\)/);
  assert.match(entry, /creatorEnabled: configs.feature\("enable_avaturn_creator"\) === true/);
  assert.match(entry, /socketConnected: socket.isConnected\(\)/);
  assert.match(entry, /callbacks: previous.callbacks \+ 1/);
  assert.match(entry, /"data-callbackcount": saved.callbacks/);
  assert.match(entry, /callbackcount: \$\{saved.callbacks\}/);
  assert.match(entry, /editor && status.join === "JOINED" && React.createElement/);
  assert.equal((entry.match(/setInterval\(/g) || []).length, 1);
  assert.equal(AVATURN_OBSERVATION_CEILING_MS, 300000);
  assert.equal(AVATURN_OBSERVATION_INTERVAL_MS, 100);
  assert.match(entry, /performance.now\(\) - started >= AVATURN_OBSERVATION_CEILING_MS/);
  assert.match(entry, /clearInterval\(intervalRef.current\)/);
  assert.match(entry, /unsubscribe\?\.\(\)/);
  assert.match(entry, /window.removeEventListener\("pagehide", pagehide\)/);
  assert.match(entry, /stopObservationRef.current\?\.\("harness_teardown"\)/);
  assert.match(entry, /if \(initialSid !== null\) return/);
  assert.match(module, /originalSignal.removeEventListener\("abort", abortListener\)/);
  assert.match(module, /controller === null && originalEditor.uploadInFlight === false/);
  assert.match(module, /facts.abort_event_seen && facts.aborted_signal && facts.off_observed/);
  assert.doesNotMatch(entry + module, /\.abort\s*\(|\.uploadAvatar\s*\(|\.setState\s*\(|\.isAvaturnEnabled\s*\(|\.trigger\s*\(|configs\.set|dispatchEvent\s*\(|store\.update\s*\(|fetch\s*\(|uploadAvatar\s*=|globalThis\.fetch|window\.fetch|sdk\.(init|on|exportAvatar)|acceptCreatorFile|handleAvaturnExportStart/);
  const invalidate = product.slice(product.indexOf("  invalidateCreatorFile ="), product.indexOf("  handleCreatorError ="));
  assert.doesNotMatch(invalidate, /uploadInFlight|avaturnSaveController/);
  assert.match(product, /finally \{\s*if \(this.avaturnSaveController === controller\) this.avaturnSaveController = null;\s*this.uploadInFlight = false/);
  // These source checks document the observation seam only. They cannot prove
  // a mounted React instance, genuine SDK Next, native SQL OFF or network abort.
});
